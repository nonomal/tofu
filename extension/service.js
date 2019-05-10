'use strict';
import Task from './task.js';
import Storage from './storage.js';


/**
 * Service status code
 */
export const SERVICE_STATUS = {
    STOPPED: 1,
    START_PENDING: 2,
    STOP_PENDING: 3,
    RUNNING: 4
};


/**
 * Class AsyncBlockingQueue
 */
class AsyncBlockingQueue {
    constructor() {
        this.resolves = [];
        this.promises = [];
    }

    _add() {
        this.promises.push(
            new Promise(resolve => {
                this.resolves.push(resolve);
            })
        );
    }

    enqueue(item) {
        if (!this.resolves.length) this._add();
        let resolve = this.resolves.shift();
        resolve(item);
    }

    dequeue() {
        if (!this.promises.length) this._add();
        return this.promises.shift();
    }

    isEmpty() {
        return !this.promises.length;
    }

    isBlocked() {
        return !!this.resolves.length;
    }

    clear() {
        this.promises.length = 0;
    }

    get length() {
        return (this.promises.length - this.resolves.length);
    }
}


/**
 * Class StateChangeEvent
 */
class StateChangeEvent extends Event {
    constructor(originalState, currentState) {
        super('statechange');
        this.originalState = originalState;
        this.currentState = currentState;
    }
}


/**
 * Class Service
 */
export default class Service extends EventTarget {
    constructor() {
        super();
        this._ports = new Map();
        this._taskQueue = new AsyncBlockingQueue();
        this._status = SERVICE_STATUS.STOPPED;
        this.requestInterval = 1000;
        this.lastRequest = 0;
        chrome.runtime.onConnect.addListener(port => this.onConnect(port));
    }

    /**
     * Get all service statuses
     * @returns {object}
     */
    get statuses() {
        return SERVICE_STATUS;
    }

    /**
     * Load settings
     * @param {object} settings
     */
    loadSettings(settings) {
        if (settings['service.request.interval']) {
            this.requestInterval = settings['service.request.interval'];
        }
    }

    /**
     * Get port unique name
     * @param {chrome.runtime.Port} port 
     * @returns {string}
     */
    getPortName(port) {
        let tab = port.sender.tab;
        return `${port.name}-${tab.windowId}-${tab.id}`;
    }

    /**
     * On connect
     * @param {chrome.runtime.Port} port 
     */
    onConnect(port) {
        this._ports.set(this.getPortName(port), port);
        port.onMessage.addListener(message => this.onMessage(port, message));
        port.onDisconnect.addListener(port => this.onDisconnect(port));
    }

    /**
     * On disconnect
     * @param {chrome.runtime.Port} port 
     */
    onDisconnect(port) {
        this._ports.delete(this.getPortName(port));
    }

    /**
     * On receive message
     * @param {chrome.runtime.Port} port 
     * @param {any} message 
     */
    onMessage(port, message) {
        switch (message.type) {
            case 'syscall':
            let retVal = this[message.method].apply(this, message.args);
            port.postMessage({
                type: message.type,
                id: message.id,
                return: retVal
            });
            break;
        }
    }

    /**
     * Post message
     * @param {chrome.runtime.Port} port 
     * @param {any} message 
     */
    postMessage(port, message) {
        try {
            return port.postMessage(message);
        } catch (e) {
            return false;
        }
    }

    /**
     * Broadcast message
     * @param {any} message 
     */
    broadcast(message) {
        for (let port of this._ports.values()) {
            this.postMessage(port, message);
        }
    }

    /**
     * Ping test
     * @param {any} payload 
     * @returns {string}
     */
    ping(payload) {
        return {'pang': payload};
    }

    /**
     * Get status code
     * @return {number}
     */
    get status() {
        return this._status;
    }

    /**
     * Start handling task queue
     */
    start() {
        let originalState = this._status;
        if (originalState != SERVICE_STATUS.STOPPED) return false;
        this._status = SERVICE_STATUS.START_PENDING;
        this.dispatchEvent(new StateChangeEvent(originalState, this._status));
        if (this._continuation) {
            this._continuation();
        }
        return true;
    }

    /**
     * Stop handling task queue
     */
    stop() {
        let originalState = this._status;
        if (originalState != SERVICE_STATUS.RUNNING && originalState != SERVICE_STATUS.START_PENDING) return false;
        this._status = SERVICE_STATUS.STOP_PENDING;
        this.dispatchEvent(new StateChangeEvent(originalState, this._status));
        return true;
    }

    /**
     * assign a task
     * @param {string} task 
     * @param {Array | null} args 
     * @returns {Service}
     */
    assign(task, args = null) {
        this._taskQueue.enqueue({
            name: task,
            args: Array.isArray(args) ? args : []
        });
    }

    /**
     * Continue the task
     */
    continue() {
        let executor, originalState = this._status;

        switch (originalState) {
            case SERVICE_STATUS.RUNNING:
            return Promise.resolve();

            case SERVICE_STATUS.START_PENDING:
            executor = resolve => {
                this._status = SERVICE_STATUS.RUNNING;
                this.dispatchEvent(new StateChangeEvent(originalState, this._status));
                resolve();
            };
            break;

            case SERVICE_STATUS.STOP_PENDING:
            executor = resolve => {
                this._status = SERVICE_STATUS.STOPPED;
                this.dispatchEvent(new StateChangeEvent(originalState, this._status));
                this._continuation = resolve;
            };
            break;

            case SERVICE_STATUS.STOPPED:
            executor = resolve => this._continuation = resolve;
        }

        return new Promise(executor);
    }

    /**
     * Idle the service
     */
    idle() {
        let originalState = this._status;
        if (originalState == SERVICE_STATUS.RUNNING) {
            this._status = SERVICE_STATUS.START_PENDING;
            this.dispatchEvent(new StateChangeEvent(originalState, this._status));
            return Promise.resolve();
        }
        return this.continue();
    }

    /**
     * Get singleton instance
     * @returns {Service}
     */
    static get instance() {
        if (!Service._instance) {
            Service._instance = new Service();
        }
        return Service._instance;
    }

    /**
     * Startup service
     * @returns {Service}
     */
    static async startup() {
        const RUN_FOREVER = true;
        const SERVICE_SETTINGS = ['service.request.interval'];

        let service = Service.instance;
        service.loadSettings(await new Promise(resolve => {
            chrome.storage.sync.get(SERVICE_SETTINGS, resolve);
        }));

        let lastRequest = 0;
        let fetchURL = (input, init) => {
            let promise = service.continue();
            let requestInterval = lastRequest + service.requestInterval - Date.now();
            if (requestInterval > 0) {
                promise = promise.then(() => {
                    return new Promise(resolve => {
                        setTimeout(resolve, requestInterval);
                    });
                });
            }
            return promise.then(() => {
                lastRequest = Date.now();
                return fetch(input, init);
            });
        };
        let storage = new Storage('grave');

        while (RUN_FOREVER) {
            let taskArgs = await service._taskQueue.dequeue();
            let task = await Task.create(taskArgs.name, taskArgs.args);
            await task.run(fetchURL, storage);
            await service.idle();
        }

    }
}
