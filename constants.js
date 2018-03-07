var pjson = require('./package.json');
exports.constants = {
	"name": pjson.name,
	"version": pjson.version,
//
	"host": "127.0.0.1",
	"port": "8000",
	"users": "auth_users",
//
	"prog_node": "/usr/local/bin/node",
	"prog_node": "/usr/bin/node",
};
