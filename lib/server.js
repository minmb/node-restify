// Copyright 2012 Mark Cavage, Inc.  All rights reserved.

var domain = require('domain');
var EventEmitter = require('events').EventEmitter;
var http = require('http');
var https = require('https');
var url = require('url');
var util = require('util');

var assert = require('assert-plus');
var mime = require('mime');
var once = require('once');
var spdy = require('spdy');

var dtrace = require('./dtrace');
var errors = require('./errors');
var formatters = require('./formatters');
var shallowCopy = require('./utils').shallowCopy;

// Ensure these are loaded
require('./request');
require('./response');



///--- Globals

var sprintf = util.format;

var BadMethodError = errors.BadMethodError;
var InvalidVersionError = errors.InvalidVersionError;
var ResourceNotFoundError = errors.ResourceNotFoundError;

var PROXY_EVENTS = [
        'clientError',
        'close',
        'connection',
        'error',
        'listening',
        'secureConnection',
        'upgrade'
];



///--- Helpers

function argumentsToChain(args, start) {
        assert.ok(args);

        args = Array.prototype.slice.call(args, start);

        if (args.length < 0)
                throw new TypeError('handler (function) required');

        var chain = [];

        function process(handlers) {
                for (var i = 0; i < handlers.length; i++) {
                        if (Array.isArray(handlers[i])) {
                                process(handlers[i], 0);
                        } else {
                                assert.func(handlers[i], 'handler');
                                chain.push(handlers[i]);
                        }
                }

                return (chain);
        }

        return (process(args));
}


function mergeFormatters(fmt) {
        var arr = [];
        var defaults = Object.keys(formatters).length;
        var i = 0;
        var obj = {};

        function addFormatter(src, k) {
                assert.func(src[k], 'formatter');

                var q;
                var t = k;
                if (k.indexOf(';') !== -1) {
                        /* JSSTYLED */
                        var tmp = k.split(/\s*;\s*/);
                        t = tmp[0];
                        if (tmp[1].indexOf('q=') !== -1) {
                                q = parseFloat(tmp[1].split('=')[1], 10) * 10;
                        }
                }

                if (k.indexOf('/') === -1)
                        k = mime.lookup(k);

                obj[t] = src[k];
                arr.push({
                        q: q || (i + defaults),
                        t: t
                });
                i++;
        }

        Object.keys(formatters).forEach(addFormatter.bind(this, formatters));
        Object.keys(fmt || {}).forEach(addFormatter.bind(this, fmt || {}));

        arr = arr.sort(function (a, b) {
                return (b.q - a.q);
        }).map(function (a) {
                return (a.t);
        });

        return ({
                formatters: obj,
                acceptable: arr
        });
}



///--- API

function Server(options) {
        assert.object(options, 'options');
        assert.object(options.log, 'options.log');
        assert.object(options.router, 'options.router');

        var self = this;

        EventEmitter.call(this);

        this.before = [];
        this.chain = [];
        this.log = options.log;
        this.name = options.name || 'restify';
        this.router = options.router;
        this.routes = {};
        this.secure = false;
        this.versions = options.versions || options.version || [];

        var fmt = mergeFormatters(options.formatters);
        this.acceptable = fmt.acceptable;
        this.formatters = fmt.formatters;

        if (options.spdy) {
                this.spdy = true;
                this.server = spdy.createServer(options.spdy);
        } else if ((options.cert || options.certificate) && options.key) {
                this.ca = options.ca;
                this.certificate = options.certificate || options.cert;
                this.key = options.key;
                this.passphrase = options.passphrase || null;
                this.secure = true;

                this.server = https.createServer({
                        ca: self.ca,
                        cert: self.certificate,
                        key: self.key,
                        passphrase: self.passphrase,
                        rejectUnauthorized: options.rejectUnauthorized,
                        requestCert: options.requestCert
                });
        } else {
                this.server = http.createServer();
        }

        this.router.on('mount', this.emit.bind(this, 'mount'));

        PROXY_EVENTS.forEach(function (e) {
                self.server.on(e, self.emit.bind(self, e));
        });

        // Now the things we can't blindly proxy
        this.server.on('checkContinue', function onCheckContinue(req, res) {
                if (self.listeners('checkContinue').length > 0) {
                        self.emit('checkContinue', req, res);
                        return;
                }

                if (!options.noWriteContinue)
                        res.writeContinue();

                self._setupRequest(req, res);
                self._handle(req, res, true);
        });

        this.server.on('request', function onRequest(req, res) {
                /* JSSTYLED */
                if (/^\/socket.io.*/.test(req.url) &&
                    self.listeners('request').length > 0) {
                        self.emit('request', req, res);
                        return;
                }

                self._setupRequest(req, res);
                self._handle(req, res);
        });

        this.__defineGetter__('maxHeadersCount', function () {
                return (self.server.maxHeadersCount);
        });

        this.__defineSetter__('maxHeadersCount', function (c) {
                self.server.maxHeadersCount = c;
                return (c);
        });


        this.__defineGetter__('url', function () {
                if (self.socketPath)
                        return ('http://' + self.socketPath);

                var addr = self.address();
                var str = '';
                if (self.spdy) {
                        str += 'spdy://';
                } else if (self.secure) {
                        str += 'https://';
                } else {
                        str += 'http://';
                }
                str += addr.address;
                str += ':';
                str += addr.port;
                return (str);
        });
}
util.inherits(Server, EventEmitter);
module.exports = Server;


Server.prototype.address = function address() {
        return (this.server.address());
};

/**
 * Gets the server up and listening.
 *
 * You can call like:
 *  server.listen(80)
 *  server.listen(80, '127.0.0.1')
 *  server.listen('/tmp/server.sock')
 *
 * @param {Function} callback optionally get notified when listening.
 * @throws {TypeError} on bad input.
 */
Server.prototype.listen = function listen() {
        var args = Array.prototype.slice.call(arguments);
        return (this.server.listen.apply(this.server, args));
};


/**
 * Shuts down this server, and invokes callback (optionally) when done.
 *
 * @param {Function} callback optional callback to invoke when done.
 */
Server.prototype.close = function close(callback) {
        if (callback)
                assert.func(callback, 'callback');

        this.server.once('close', function onClose() {
                return (callback ? callback() : false);
        });

        return (this.server.close());
};


// Register all the routing methods
/**
 * Mounts a chain on the given path against this HTTP verb
 *
 * @param {Object} options the URL to handle, at minimum.
 * @return {Route} the newly created route.
 */
[
        'del',
        'get',
        'head',
        'opts',
        'post',
        'put',
        'patch'
].forEach(function (method) {
        Server.prototype[method] = function (opts) {
                if (opts instanceof RegExp || typeof (opts) === 'string') {
                        opts = {
                                path: opts
                        };
                } else if (typeof (opts) === 'object') {
                        opts = shallowCopy(opts);
                } else {
                        throw new TypeError('path (string) required');
                }

                if (arguments.length < 2)
                        throw new TypeError('handler (function) required');

                var chain = [];
                var route;
                var self = this;

                function addHandler(h) {
                        assert.func(h, 'handler');

                        chain.push(h);
                }

                if (method === 'del')
                        method = 'DELETE';
                if (method === 'opts')
                        method = 'OPTIONS';
                opts.method = method.toUpperCase();
                opts.versions = opts.versions || opts.version || self.versions;
                if (!Array.isArray(opts.versions))
                        opts.versions = [opts.versions];

                if (!opts.name) {
                        opts.name = method + '-' + (opts.path || opts.url);
                        if (opts.versions.length > 0) {
                                opts.name += '-' + opts.versions.join('--');
                        }
                }
                opts.name = opts.name.replace(/\W/g, '').toLowerCase();

                if (!(route = this.router.mount(opts)))
                        return (false);

                this.chain.forEach(addHandler);
                argumentsToChain(arguments, 1).forEach(addHandler);
                this.routes[route] = chain;

                return (route);
        };
});


/**
 * Minimal port of the functionality offered by Express.js Route Param
 * Pre-conditions
 * @link http://expressjs.com/guide.html#route-param%20pre-conditions
 *
 * This basically piggy-backs on the `server.use` method. It attaches a
 * new middleware function that only fires if the specified parameter exists
 * in req.params
 *
 * Exposes an API:
 *   server.param("user", function (req, res, next) {
 *     // load the user's information here, always making sure to call next()
 *   });
 *
 * @param {String} The name of the URL param to respond to
 * @param {Function} The middleware function to execute
 */
Server.prototype.param = function param(name, fn) {
        this.use(function _param(req, res, next) {
                if (req.params && req.params[name]) {
                        fn.call(this, req, res, next, req.params[name], name);
                } else {
                        next();
                }
        });

        return (this);
};


/**
 * Removes a route from the server.
 *
 * You  pass in the route 'blob' you got from a mount call.
 *
 * @param {String} name the route name.
 * @return {Boolean} true if route was removed, false if not.
 * @throws {TypeError} on bad input.
 */
Server.prototype.rm = function rm(route) {
        var r = this.router.unmount(route);
        if (r && this.routes[r])
                delete this.routes[r];

        return (r);
};


/**
 * Installs a list of handlers to run _before_ the "normal" handlers of all
 * routes.
 *
 * You can pass in any combination of functions or array of functions.
 *
 * @throws {TypeError} on input error.
 */
Server.prototype.use = function use() {
        var self = this;

        (argumentsToChain(arguments) || []).forEach(function (h) {
                self.chain.push(h);
        });

        return (this);
};


/**
 * Gives you hooks to run _before_ any routes are located.  This gives you
 * a chance to intercept the request and change headers, etc., that routing
 * depends on.  Note that req.params will _not_ be set yet.
 */
Server.prototype.pre = function pre() {
        var self = this;

        argumentsToChain(arguments).forEach(function (h) {
                self.before.push(h);
        });

        return (this);
};


Server.prototype.toString = function toString() {
        var LINE_FMT = '\t%s: %s\n';
        var SUB_LINE_FMT = '\t\t%s: %s\n';
        var self = this;
        var str = '';

        function handlersToString(arr) {
                var s = '[' + arr.map(function (b) {
                        return (b.name || 'function');
                }).join(', ') + ']';

                return (s);
        }

        str += sprintf(LINE_FMT, 'Accepts', this.acceptable.join(', '));
        str += sprintf(LINE_FMT, 'Name', this.name);
        str += sprintf(LINE_FMT, 'Pre', handlersToString(this.before));
        str += sprintf(LINE_FMT, 'Router', this.router.toString());
        str += sprintf(LINE_FMT, 'Routes:', '');
        Object.keys(this.routes).forEach(function (k) {
                var handlers = handlersToString(self.routes[k]);
                str += sprintf(SUB_LINE_FMT, k, handlers);
        });
        str += sprintf(LINE_FMT, 'Secure', this.secure);
        str += sprintf(LINE_FMT, 'Url', this.url);
        str += sprintf(LINE_FMT, 'Version', this.version);

        return (str);
};



///--- Private methods

Server.prototype._handle = function _handle(req, res) {
        var log = this.log;
        var self = this;

        function _route() {
                if (log.trace()) {
                        log.trace({
                                req: req,
                                req_id: req.getId()
                        }, 'checking for route');
                }

                function emitRouteError(name, err) {
                        if (self.listeners(name).length > 0) {
                                self.emit(name, req, res, once(function () {
                                        self.emit('after', req, res, null);
                                }));
                        } else {
                                res.send(err);
                                self.emit('after', req, res, null);
                        }
                }

                self.router.find(req, res, function onRoute(err, r, ctx) {
                        if (err) {
                                if (err.statusCode === 404 &&
                                    req.method === 'OPTIONS' &&
                                    req.url === '*') {
                                        res.send(200);
                                        self.emit('after', req, res, null);
                                        return;
                                }
                                log.trace({
                                        err: err,
                                        req_id: req.getId()
                                }, 'router errored out');

                                switch (err.name) {
                                case 'ResourceNotFoundError':
                                        emitRouteError('NotFound', err);
                                        break;

                                case 'MethodNotAllowedError':
                                        emitRouteError('MethodNotAllowed',
                                                       err);
                                        break;

                                case 'InvalidVersionError':
                                        emitRouteError('VersionNotAllowed',
                                                       err);
                                        break;

                                case 'UnsupportedMediaTypeError':
                                        emitRouteError('UnsupportedMediaType',
                                                       err);
                                        break;

                                default:
                                        emitRouteError(' ', err);
                                        break;
                                }
                        } else if (r === true) {
                                // this probably indicates a preflight request
                                // at any rate semantic means return 200
                                res.send(200);
                                self.emit('after', req, res, null);
                        } else if (!r || !self.routes[r]) {
                                log.trace({
                                        req_id: req.getId()
                                }, 'no route found (null route)');
                                emitRouteError('NotFound', 404);
                        } else {
                                if (log.trace()) {
                                        log.trace({
                                                req_id: req.getId(),
                                                route: r
                                        }, 'route found');
                                }

                                req.context = req.params = ctx;
                                var chain = self.routes[r];
                                self._run(req, res, r, chain, function done(e) {
                                        self.emit('after', req, res, r, e);
                                });
                        }
                });
        }

        // We need to check if should run the _pre_ chain first.
        if (this.before.length > 0) {
                if (log.trace())
                        log.trace({req: req}, 'running pre chain');

                this._run(req, res, null, this.before, function (err) {
                        if (err) {
                                log.trace({
                                        err: err
                                }, 'pre chain errored out. Done.');
                                return (false);
                        }

                        return (_route());
                });
                return (false);
        }

        return (_route());
};


Server.prototype._run = function _run(req, res, route, chain, callback) {
        var d;
        var i = -1;
        var id = dtrace.nextId();
        var log = this.log;
        var self = this;

        function ifError(n) {
                function _ifError(err) {
                        if (err) {
                                err._restify_next = n;
                                throw err;
                        }
                }
                return (_ifError);
        }

        function next(err) {
                // The goofy checks here are to make sure we fire the DTrace
                // probes after an error might have been sent, as in a handler
                // return next(new Error) is basically shorthand for sending an
                // error via res.send(), so we do that before firing the dtrace
                // probe (namely so the status codes get updated in the
                // response).
                var done = false;
                if (err) {
                        if (log.trace())
                                log.trace({err: err}, 'next(err=%s)',
                                          err.name || 'Error');
                        res.send(err);
                        done = true;
                }

                // Callers can stop the chain from proceding if they do
                // return next(false); This is useful for non-errors, but where
                // a response was sent and you don't want the chain to keep
                // going
                if (err === false)
                        done = true;

                // Fire DTrace done for the previous handler.
                if ((i + 1) > 0 && chain[i]) {
                        dtrace._rstfy_probes['handler-done'].fire(function () {
                                return ([
                                        self.name,
                                        route !== null ? route : 'pre',
                                        chain[i].name || ('handler-' + i),
                                        id
                                ]);
                        });
                }

                // Run the next handler up
                if (!done && chain[++i]) {
                        if (log.trace())
                                log.trace('running %s', chain[i].name || '?');

                        dtrace._rstfy_probes['handler-start'].fire(function () {
                                return ([
                                        self.name,
                                        route !== null ? route : 'pre',
                                        chain[i].name || ('handler-' + i),
                                        id
                                ]);
                        });

                        var n = once(next);
                        n.ifError = ifError(n);
                        return (chain[i].call(self, req, res, n));
                }

                dtrace._rstfy_probes['route-done'].fire(function () {
                        return ([
                                self.name,
                                route !== null ? route : 'pre',
                                id,
                                res.statusCode || 200,
                                res.headers()
                        ]);
                });

                if (route === null) {
                        self.emit('preDone', req, res);
                } else {
                        self.emit('done', req, res, route);
                }

                return (callback ? callback(err) : true);
        }
        var n1 = once(next);
        n1.ifError = ifError(n1);

        dtrace._rstfy_probes['route-start'].fire(function () {
                return ([
                        self.name,
                        route !== null ? route : 'pre',
                        id,
                        req.method,
                        req.href(),
                        req.headers
                ]);
        });

        d = domain.create();
        d.add(req);
        d.add(res);
        d.on('error', function onError(err) {
                if (err._restify_next) {
                        err._restify_next(err);
                } else {
                        log.trace({err: err}, 'uncaughtException');
                        self.emit('uncaughtException', req, res, route, err);
                }
        });
        d.run(n1);
};


Server.prototype._setupRequest = function _setupRequest(req, res) {
        req.log = res.log = this.log;
        req._time = res._time = Date.now();

        res.acceptable = this.acceptable;
        res.formatters = this.formatters;
        res.req = req;
        res.serverName = this.name;
        res.version = this.router.versions[this.router.versions.length - 1];
};
