module.exports = function(vm){    
    return {
        log: function(args) {
            if (vm.logging) {
                try{
                    console.log.apply(null, JSON.parse(args))
                }
                catch(err){}                
            }
        },
        dir: function(args) {
            if (vm.logging) {
                try{
                    console.dir.apply(null, JSON.parse(args))
                }
                catch(err){}                
            }
        }
    }
};