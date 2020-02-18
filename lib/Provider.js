const net = require('net');

const { parseInvoker } = require('./data/parser');
const { formatInvoker, formatData } = require('./data/formater');
const socketUtils = require('./socket-utils');
const { copyProperties } = require('./util');

class Provider {
    constructor({
        logger,
        port,
        name,
        services,
        extentions = {},
        registry
    }) {
        if (!registry) {
            throw new Error('必须传入注册中心配置`registry`');
        }

        const {
            application = {},
            context = {},
        } = extentions;

        this.logger = logger || console;

        this.app = copyProperties({
            logger: this.logger
        }, application);

        function Context(app) {
            this.app = app;
        }
        copyProperties(Context.prototype, context);

        this.Context = Context;

        Object.defineProperty(this.app, 'service', {
            writable: false,
            value: {}
        });

        this.port = port;
        this._handleRegisterError = this._handleRegisterError.bind(this);

        this._initServices(services);
        this.clients = [];

        this.providerName = name;
        this.registry = registry;
    }

    start(cb) {
        if (!this.started) {
            this._initServer();
            this.started = true;
            this.server.listen(this.port, () => {
                this.logger.info('opened server on', this.server.address());
                this.register();
                cb && cb();
            });
        }
    }

    _initServer() {
        const server = net.createServer((socket) => {
            socket.on('timeout', () => {
                this.logger.info('socket timeout');
                socket.end();
            });

            socketUtils.onReceiveBlock(socket, (type, buf) => {
                // console.log(buf);
                if (type == 0) {
                    // 心跳检测
                    socketUtils.sendHeartbeat(socket);
                    return;
                }

                const invoker = parseInvoker(buf);
                // 写入serviceId
                const serviceIdBuf = Buffer.alloc(4);
                serviceIdBuf.writeUInt32BE(invoker.serviceId);

                const index = invoker.serviceName.indexOf('.');
                const className = invoker.serviceName.slice(0, index);
                const methodName = invoker.serviceName.slice(index + 1);

                // 获取服务类
                let result;
                const service = this._getService(className);
                if (!service) {
                    result = { __typeof: 'ERROR', success: false, code: 'SERVICE_NOT_EXISTS', message: invoker.serviceName };
                } else {
                    // 获取服务执行方法
                    const method = service[methodName];
                    if (!method) {
                        result = { __typeof: 'ERROR', success: false, code: "METHOD_NOT_EXISTS", message: invoker.serviceName };
                    } else {
                        try {
                            result = invoker.args && invoker.args.length
                                ? method.apply(service, invoker.args)
                                : method.call(service);
                        } catch (e) {
                            result = { __typeof: 'ERROR', success: false, code: "INVOKE_METHOD_ERROR", message: e.message, stack: e.stack };
                        }
                    }
                }

                // 将结果返回给client
                if (result && typeof result.then === 'function') {
                    result
                        .then((res) => {
                            this.logger.info(invoker, 'result:', result);
                            socketUtils.sendBlock(socket, Buffer.concat([serviceIdBuf, formatData(res)]));
                        })
                        .catch(e => {
                            this.logger.error(e);
                            socketUtils.sendBlock(socket, Buffer.concat([serviceIdBuf, formatData({ __typeof: 'ERROR', success: false, code: "INVOKE_METHOD_ERROR", message: e.message, stack: e.stack })]));
                        });
                } else {
                    this.logger.info(invoker, 'result:', result);
                    socketUtils.sendBlock(socket, Buffer.concat([serviceIdBuf, formatData(result)]));
                }
            });
        })
            .on('error', (err) => {
                // 错误处理
                if (err.code === 'EADDRINUSE') {
                    this.logger.error('Address in use', err);
                } else {
                    this.logger.error(err);
                }
                throw err;
            });
        this.server = server;
    }

    _initServices(services) {
        const classMap = Array.isArray(services)
            ? services.reduce((classes, serviceClass) => {
                const className = serviceClass.name.replace(/Service$/, '')
                    .replace(/^[A-Z]/, (match) => {
                        return match.toLowerCase();
                    });
                classes[className] = serviceClass;
                return classes;
            }, {})
            : services;

        this.serviceMap = {};
        this.serviceClassMap = Object.keys(classMap).reduce((serviceClassMap, className) => {
            const serviceClass = classMap[className];

            serviceClassMap[className] = serviceClass;

            serviceClass.prototype.app = this.app;
            serviceClass.prototype.logger = this.logger;

            Object.defineProperty(this.app.service, className, {
                get: () => {
                    return this._getService(className);
                }
            });

            return serviceClassMap;
        }, {});
    }

    _getService(className) {
        let service = this.serviceMap[className];
        if (!service) {
            const ServiceClass = this.serviceClassMap[className];
            if (!ServiceClass) return null;

            return (this.serviceMap[className] = new ServiceClass({
                logger: this.logger,
                ctx: new this.Context(this.app),
                app: this.app,
            }));
        }
        return service;
    }

    stop(callback) {
        if (this.hbTimeout) clearTimeout(this.hbTimeout);
        this.server.close(callback);
        this.server = null;
        this.started = false;
    }

    register() {
        if (this.hbTimeout) {
            clearTimeout(this.hbTimeout);
            this.hbTimeout = null;
        }

        const { registry } = this;
        const info = formatInvoker('registerProvider', [{
            name: this.providerName,
            port: this.port
        }]);

        if (!this.registryClient) {
            const client = net.createConnection({
                host: registry.host,
                port: registry.port
            }, () => {
                socketUtils.sendBlock(client, info.content);
            })
                .on('error', this._handleRegisterError)
                .on('close', this._handleRegisterError)
                .on('end', this._handleRegisterError)
                .on('timeout', () => {
                    client.end();
                });

            socketUtils.onReceiveBlock(client, (type) => {
                let timeout;
                if (type == 1) {
                    // 注册成功
                    timeout = 5000;
                } else {
                    timeout = 3000;
                }

                this.hbTimeout = setTimeout(() => {
                    this.hbTimeout = null;
                    this.register();
                }, timeout);
            });

            this.registryClient = client;
        } else {
            socketUtils.sendBlock(this.registryClient, info.content);
        }
    }

    _handleRegisterError() {
        this.registryClient = null;
        if (!this.hbTimeout) {
            this.hbTimeout = setTimeout(() => {
                this.register();
            }, 5000);
        }
    }
}

exports.createProvider = function createProvider(options) {
    const provider = new Provider(options);
    return {
        start: provider.start.bind(provider),
        stop: provider.stop.bind(provider)
    };
};

exports.checkProvider = function (providerCfg, cb) {
    const client = net.createConnection({
        host: providerCfg.host,
        port: providerCfg.port,
        timeout: providerCfg.timeout || 1000
    }, () => {
        console.log('connected to provider!');
        client.write(Buffer.from([0]));
    })
        .on('error', (err) => {
            cb && cb(err);
        })
        .on('timeout', () => {
            cb && cb(new Error('TIMEOUT'));
        })
        .on('data', (buf) => {
            if (buf.length == 1 && buf.readUInt8() === 0) {
                client.end();
                cb && cb(null);
            } else {
                cb && cb(new Error('UNKNOW_ERROR'));
            }
        });
};