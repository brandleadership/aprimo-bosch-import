const {
    Piscina
} = require('piscina');
const os = require('os');
const cpus = os.cpus();


console.log("process.env.UV_THREADPOOL_SIZE || os.cpus().length",process.env.UV_THREADPOOL_SIZE );
console.log("process.env.UV_THREADPOOL_SIZE || os.cpus().length",os.cpus().length);