const Ivm = require('isolated-vm');
const Fs = require('fs');
const vmConsole = require('./vmConsole');
const Path = require('path');
const RootPath = process.cwd();

function getLocalPackage(name){
    let package;
    let path;
    try{
        package = require(name)
        path = Path.dirname(require.resolve(name + '/package.json'));
    }
    catch(err){
        package = require(RootPath + '/node_modules/' + name)
        path = Path.dirname(require.resolve(RootPath + '/node_modules/' + name + '/package.json'))
    }       
    return {
        rootPath: path,
        default: package,
        plugin: package.plugin,
        middleware: package.middleware
    }
}
async function loadPlugins(vm, plugins, options){        
    if (Array.isArray(plugins)){
        for (let i = 0; i < plugins.length; i ++){                    
            let name = plugins[i];
            let pack = getLocalPackage(name);            
            let func = pack.plugin || pack.default
            if (typeof(func) == 'function'){                
                func(vm, null, options)
            }
        }    
    }
}
class VM {
    constructor(options) {            
        this.memoryLimit = options && options.ramLimit != undefined? options.ramLimit: 128;        
        this.timeLimit = options && options.timeLimit != undefined? options.timeLimit: 10000;
        this.logging = options && options.logging != undefined? options.logging: false;
        this.isolate = new Ivm.Isolate({memoryLimit: this.memoryLimit});
        this.token = options && options.token?options.token:'';
        this.setupContext();                
        if (options.plugins)
            loadPlugins(this, options.plugins, options)
        if (options && options.script)
            this.injectScript(options.script)            
    }
    getCpuTime() {
        if(this.isolate)
            return (this.isolate.cpuTime[0] + this.isolate.cpuTime[1] / 1e9) * 1000
        else
            return this.cpuTime;
    }    
    objectToReference(obj) {
        let result = {};
        for (let v in obj) {
            if(obj.hasOwnProperty(v)) {
                if(typeof obj[v] === 'function') {
                    result[v] = {
                        ref: new Ivm.Reference(function (...args) {
                            return obj[v](...args)
                        }), 
                        type: 'func',
                        async: obj['$$' + v]?true:false
                    };
                }
                else if(typeof obj[v] === 'object')
                    result[v] = {
                        ref: this.objectToReference(obj[v]), 
                        type: 'obj'}                    
                else
                    result[v] = obj[v];
            }
        }
        return new Ivm.Reference(result);
    }
    setupContext() {        
        this.context = this.isolate.createContextSync();        
        let jail = this.context.global
        jail.setSync('_ivm', Ivm);
        jail.setSync('global', jail.derefInto());        
        // if (this.logging)
            jail.setSync('_console', this.objectToReference(vmConsole(this)));                
        let script = this.isolate.compileScriptSync('new ' +  function () {
            let ivm = global._ivm;            
            delete global._ivm;            
            global.Plugins = {};
            global.require = function(module) {};
            global.registerComponent = function(){};
            function referenceToObject(obj) {
                if(obj.constructor.name === 'Reference') {
                    obj = obj.copySync();
                }
                let result = {};
                for (let v in obj) {
                    if(typeof(obj[v]) != 'undefined') {
                        if(obj[v]['type'] === 'func') {
                            result[v] = function (...args) {        
                                if (obj[v].async)  
                                    result = obj[v]['ref'].applySyncPromise(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()))                                    
                                else     
                                    result = obj[v]['ref'].applySync(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
                                return result;
                            }
                        } 
                        else if(obj[v]['type'] === 'obj')
                            result[v] = referenceToObject(obj[v]['ref'])
                        else
                            result[v] = obj[v];
                    }
                }
                return result;
            };
            if (global._console)
                var console = referenceToObject(global._console);
            delete global._console;
            global.console = {
                log: function(...args){      
                    if (console)          
                        console.log(JSON.stringify(args))
                },
                dir: function(...args){
                    if (console)
                        console.dir(JSON.stringify(args))
                }
            }            
            global.referenceToObject = referenceToObject;            
        })        
        script.runSync(this.context);        
    }
    injectGlobalObject(name, obj, script){
        this.context.global.setSync(name, this.objectToReference(obj));
        let s = this.isolate.compileScriptSync(`new function () {    
            global["${name}"] = referenceToObject(global["${name}"]);
            ${script || ''}
        }`)        
        s.runSync(this.context);
    }
    registerPlugin(name, obj, script){        
        this.context.global.setSync('_Plugins_' + name, this.objectToReference(obj));
        let s = this.isolate.compileScriptSync(`new function () {              
            global.Plugins["${name}"] = referenceToObject(global._Plugins_${name});
            delete global._Plugins_${name};
            ${script || ''}
        }`)
        s.runSync(this.context);
    }
    injectScript(code) {
        this.isolate.compileScriptSync(code).runSync(this.context);
    }
    injectModule(filePath) {
        this.injectScript(Fs.readFileSync(filePath).toString());
    }
    compileScript(script) {
        this.script = script;
        if (this.compiledScript)
            this.compiledScript.release();
        this.compiledScript = this.isolate.compileScriptSync(script);
        return this.compiledScript;
    }
    async getContextProperty(prop) {
        try{
            let context = this.context.global;
            prop = prop.split('.');
            for (let p in prop) {
                context = await context.get(prop[p]);
            }
            if (typeof(context) == 'object') 
                return await context.copy()
            else
                return context
        }
        catch(err){}
    }
    async execute() {
        let self = this;
        clearTimeout(this.timeLimitTimer);
        this.timeLimitTimer = setTimeout(function(){
            self.destroy();
        }, this.timeLimit)
        let result = this.compiledScript.runSync(this.context, {})
        return result;
    }
    async eval(script){           
        const fn = await this.context.eval(script, { reference: true })
        let self = this;        
        let result = await fn.result.apply(undefined, [], {result: { promise: true } });
    }
    destroy() {        
        clearTimeout(this.timeLimitTimer);
        if (this.isolate){
            this.cpuTime = (this.isolate.cpuTime[0] + this.isolate.cpuTime[1] / 1e9) * 1000
            this.isolate.dispose();
            delete this.isolate;
            if (this.compiledScript)
                this.compiledScript.release();
            delete this.compiledScript;
            delete this.context;
            delete this;
        }
    }
}
module.exports = VM;