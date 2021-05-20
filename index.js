const Ivm = require('isolated-vm');
const Fs = require('fs');
const vmConsole = require('./vmConsole');
const Path = require('path');
const RootPath = process.cwd();
const EventEmitter = function(){
    return {
        events: {},
        emit(event, ...args) {
            (this.events[event] || []).forEach(function(cb){
                try{
                    cb(...args)
                }
                catch(err){}
            })
        },
        on(event, cb) {
            this.events[event] = this.events[event] || [];
            this.events[event].push(cb);
            return () =>
                (this.events[event] = this.events[event].filter(e => e !== cb))
        }
    }
}
function getLocalPackage(name){
    let package;
    let path;
    try{
        package = require(name);
        path = Path.dirname(require.resolve(name + '/package.json'));
    }
    catch(err){
        package = require(RootPath + '/node_modules/' + name);
        path = Path.dirname(require.resolve(RootPath + '/node_modules/' + name + '/package.json'));
    };
    return {
        rootPath: path,
        default: package,
        plugin: package._plugin,
        middleware: package._middleware
    };
};
async function loadPlugins(vm, plugins, options){
    if (Array.isArray(plugins)){
        for (let i = 0; i < plugins.length; i ++){                    
            let name = plugins[i];
            let pack = getLocalPackage(name);
            let func = pack.plugin || pack.default;
            if (typeof(func) == 'function'){                
                func(vm, null, options);
            };
        };
    };
};
class VM {
    constructor(options) {            
        this.memoryLimit = options && options.ramLimit != undefined? options.ramLimit: 128;        
        this.timeLimit = options && options.timeLimit != undefined? options.timeLimit: 10000;
        this.logging = options && options.logging != undefined? options.logging: false;
        this.isolate = new Ivm.Isolate({memoryLimit: this.memoryLimit});
        this.token = options && options.token?options.token:'';
        this.setupContext(); 
        this.events = EventEmitter();
        if (options.plugins){
            loadPlugins(this, options.plugins, options);
        };
        if (options && options.script){
            this.injectScript(options.script); 
        };
    };
    getCpuTime() {
        if(this.isolate){
            return (this.isolate.cpuTime[0] + this.isolate.cpuTime[1] / 1e9) * 1000;
        }
        else{
            return this.cpuTime;
        };
    };
    functionToReference(obj){
        return new Ivm.Reference(function (...args) {
            return obj(...args);
        });
    };
    objectToReference(obj) {
        let result = {};
        for (let v in obj) {
            if(obj.hasOwnProperty(v)) {
                if(typeof obj[v] === 'function') {
                    result[v] = {
                        ref: this.functionToReference(obj[v]), 
                        type: 'func',
                        async: obj['$$' + v]?true:false
                    };
                }
                else if(typeof obj[v] === 'object'){
                    result[v] = {
                        ref: this.objectToReference(obj[v]), 
                        type: 'obj'};
                }
                else{
                    result[v] = obj[v];
                };
            };
        };
        return new Ivm.Reference(result);
    };
    setupContext() {
        this.context = this.isolate.createContextSync();        
        let jail = this.context.global;        
        jail.setSync('_ivm', Ivm);
        jail.setSync('global', jail.derefInto());        
        jail.setSync('_console', this.objectToReference(vmConsole(this)));
        let script = this.isolate.compileScriptSync('new ' +  function () {
            let ivm = global._ivm;            
            delete global._ivm;        
            global.module = {
                paths: {}
            };                
            global.exports = {};
            global.Plugins = {};
            global.require = function(module) {
                return global.module.paths[module.toLowerCase()];
            };
            global.registerComponent = function(){};
            function referenceFunction(obj){
                return function(...args){
                    if (obj.async){  
                        return obj.ref.applySyncPromise(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
                    }
                    else{     
                        return obj.ref.applySync(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
                    };
                };
            };
            function referenceToObject(obj) {                
                if(obj.constructor.name === 'Reference') {
                    obj = obj.copySync();
                };
                let result = {};
                for (let v in obj) {
                    if(typeof(obj[v]) != 'undefined') {
                        if(obj[v].type === 'func') {
                            result[v] = referenceFunction(obj[v]);
                        } 
                        else if(obj[v].type === 'obj'){
                            result[v] = referenceToObject(obj[v].ref);
                        }
                        else{
                            result[v] = obj[v];
                        };
                    };
                };
                return result;
            };
            if (global._console){
                var console = referenceToObject(global._console);
            };
            delete global._console;
            global.console = {
                log: function(...args){      
                    if (console)          
                        console.log(JSON.stringify(args));
                },
                dir: function(...args){
                    if (console)
                        console.dir(JSON.stringify(args));
                }
            };
            global.referenceToObject = referenceToObject;            
        })        
        script.runSync(this.context);
    };
    injectGlobalObject(name, obj, script){
        this.context.global.setSync(name, this.objectToReference(obj));
        let s = this.isolate.compileScriptSync(`new function () {    
            global["${name}"] = referenceToObject(global["${name}"]);
            ${script || ''}
        }`);
        s.runSync(this.context);
    };
    registerPlugin(name, obj, script){
        this.context.global.setSync('_Plugins_' + name, this.objectToReference(obj));
        let s = this.isolate.compileScriptSync(`new function () {              
            global.Plugins["${name}"] = referenceToObject(global._Plugins_${name});
            delete global._Plugins_${name};
            ${script || ''}
        }`);
        s.runSync(this.context);
    };
    injectScript(code) {
        this.isolate.compileScriptSync(code).runSync(this.context);
    };
    injectModule(filePath) {
        this.injectScript(Fs.readFileSync(filePath).toString());
    };
    compileScript(script) {
        this.script = script;
        if (this.compiledScript){
            this.compiledScript.release();
        };
        this.compiledScript = this.isolate.compileScriptSync(script);
        return this.compiledScript;
    };
    async getContextProperty(prop) {
        try{
            let context = this.context.global;
            prop = prop.split('.');
            for (let p in prop) {
                context = await context.get(prop[p]);
            };
            if (typeof(context) == 'object'){ 
                return await context.copy();
            }
            else{
                return context;
            };
        }
        catch(err){};
    };
    async execute() {
        let self = this;
        clearTimeout(this.timeLimitTimer);
        this.timeLimitTimer = setTimeout(function(){
            self.destroy();
        }, this.timeLimit);
        let result = this.compiledScript.runSync(this.context, {});
        return result;
    };
    async eval(script){
        let fn = await this.context.eval(script, { reference: true });
        let result = await fn.apply(undefined, [], {result: { promise: true } });
        return result;
    };
    on(event, cb){
        return this.events.on(event, cb);
    };
    destroy() {
        clearTimeout(this.timeLimitTimer);
        if (this.isolate){
            this.cpuTime = (this.isolate.cpuTime[0] + this.isolate.cpuTime[1] / 1e9) * 1000;
            this.isolate.dispose();
            delete this.isolate;
            if (this.compiledScript)
                this.compiledScript.release();
            delete this.compiledScript;
            delete this.context;
            this.events.emit('destroy');
            delete this.events;
        };
    };
};
module.exports = VM;