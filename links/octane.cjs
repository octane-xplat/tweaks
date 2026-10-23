const path = require('node:path')
const createHooks = require('./octane-config.cjs')

module.exports = {
	hooks: createHooks(path.join(__dirname, 'octane-xplat'), path.join(__dirname, '..')),
}
