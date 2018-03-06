/*jshint esversion: 6*/
var express = require('express');
var app = express();
var auth = require('http-auth');
var https = require('https');
var crontab = require("./crontab");
var restore = require("./restore");
var moment = require('moment');

var path = require('path');
var mime = require('mime-types');
var fs = require('fs');
var busboy = require('connect-busboy'); // for file upload

// include the routes
var routes = require("./routes").routes;

// set the view engine to ejs
app.set('view engine', 'ejs');

var bodyParser = require('body-parser');
app.use(bodyParser.json());       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));
app.use(busboy()); // to support file uploads

// include all folders
app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname + '/public/css'));
app.use(express.static(__dirname + '/public/js'));
app.use(express.static(__dirname + '/config'));
app.set('views', __dirname + '/views');

// set static users
var auth_users = require("./config/auth_users").auth_users;

// configure basic auth
var basic = auth.basic({
    realm: 'SUPER SECRET STUFF'
}, function(username, password, callback) {
	app.set('username', username);
	console.log("Login username " + username)
	callback(auth_users[username] == password);
});

// create middleware that can be used to protect routes with basic auth
var authMiddleware = auth.connect(basic);

// create HTTPS_CERT and HTTPS_KEY: openssl req -x509 -nodes -days  365 -newkey rsa:2048 -keyout $HTTPS_KEY.key -out $HTTPS_CERT.crt
//                                  openssl genrsa -out $HTTPS_KEY.ca_key 2048
//                                  openssl req -x509 -nodes -days 1024 -new -key $HTTPS_KEY.ca_key -sha256 -out $HTTPS_CA_1.pem
// set files ca/cert/key for https
app.set('https_ca_bundlecert_1', (process.env.HTTPS_CA_1 || ''));
app.set('https_ca_cert', (process.env.HTTPS_CERT || ''));
app.set('https_ca_key', (process.env.HTTPS_KEY || ''));
app.set('https_host', (process.env.HTTPS_HOST || '127.0.0.1'));
app.set('https_port', (process.env.HTTPS_PORT || 9000));
// set options https
var options = {
//	ca: [fs.readFileSync(app.get('https_ca_bundlecert_1'), fs.readFileSync(PATH_TO_BUNDLE_CERT_2)],
//	ca: [fs.readFileSync(app.get('https_ca_bundlecert_1')],
	cert: fs.readFileSync(app.get('https_ca_cert')),
	key: fs.readFileSync(app.get('https_ca_key'))
};

var server = https.createServer(options, app);
// set host to 127.0.0.1 or the value set by environment var HOST
app.set('host', (process.env.HOST || '127.0.0.1'));

// set port to 8000 or the value set by environment var PORT
app.set('port', (process.env.PORT || 8000));

// root page handler
//app.get(routes.root, function(req, res) {
// root page handler with auth Middleware
app.get(routes.root, authMiddleware, function(req, res) {
	// reload the database before rendering
	crontab.reload_db();
	// send all the required parameters
	crontab.crontabs( function(docs){
		res.render('index', {
			routes : JSON.stringify(routes),
			crontabs : JSON.stringify(docs),
			backups : crontab.get_backup_names(),
			env : crontab.get_env(),
			moment: moment,
			username: app.get('username')
		});
	});
});

/*
Handle to save crontab to database
If it is a new job @param _id is set to -1
@param name, command, schedule, logging has to be sent with _id (if exists)
*/
app.post(routes.save, function(req, res) {
	// new job
	if(req.body._id == -1){
		crontab.create_new(req.body.name, req.body.command, req.body.schedule, req.body.logging, req.body.mailing);
	}
	// edit job
	else{
		crontab.update(req.body);
	}
	res.end();
});

// set stop to job
app.post(routes.stop, function(req, res) {
	crontab.status(req.body._id, true);
	res.end();
});

// set start to job
app.post(routes.start, function(req, res) {
	crontab.status(req.body._id, false);
	res.end();
});

// remove a job
app.post(routes.remove, function(req, res) {
	crontab.remove(req.body._id);
	res.end();
});

// run a job
/*** Solution 1 ***
app.get(routes.run_job, function(req, res) {
	console.log("Run[ " + req.query.job_id + " ]=[ " + req.query.job_command + " ]");
	crontab.run_job(req.query.job_id, req.query.job_env_vars, req.query.job_command, req.query.mailing);
	res.end();
});
*/
/*** Solution 2 ***/
app.post(routes.run_job, function(req, res) {
	crontab.run_job(req.body._id, function(err) {
		if (err) console.error(err);
		else res.end();
	});
});

// set crontab. Needs env_vars to be passed
app.get(routes.crontab, function(req, res, next) {
	crontab.set_crontab(req.query.env_vars, function(err) {
		if (err) next(err);
		else res.end();
	});
});

// backup crontab db
app.get(routes.backup, function(req, res) {
	crontab.backup();
	res.end();
});

// This renders the restore page similar to backup page
app.get(routes.restore, function(req, res) {
	// get all the crontabs
	restore.crontabs(req.query.db, function(docs){
		res.render('restore', {
			routes : JSON.stringify(routes),
			crontabs : JSON.stringify(docs),
			backups : crontab.get_backup_names(),
			db: req.query.db
		});
	});
});

// delete backup db
app.get(routes.delete_backup, function(req, res) {
	restore.delete(req.query.db);
	res.end();
});

// restore from backup db
app.get(routes.restore_backup, function(req, res) {
	crontab.restore(req.query.db);
	res.end();
});

// export current crontab db so that user can download it
app.get(routes.export, function(req, res) {
	var file = __dirname + '/crontabs/crontab.db';

	var filename = path.basename(file);
	var mimetype = mime.lookup(file);

	res.setHeader('Content-disposition', 'attachment; filename=' + filename);
	res.setHeader('Content-type', mimetype);

	var filestream = fs.createReadStream(file);
	filestream.pipe(res);
});

// import from exported crontab db
app.post(routes.import, function(req, res) {
	var fstream;
	req.pipe(req.busboy);
	req.busboy.on('file', function (fieldname, file, filename) {
		fstream = fs.createWriteStream(__dirname + '/crontabs/crontab.db');
		file.pipe(fstream);
		fstream.on('close', function () {
			crontab.reload_db();
			res.redirect(routes.root);
		});
	});
});

// import from current ACTUALL crontab
app.get(routes.import_crontab, function(req, res) {
	crontab.import_crontab();
	res.end();
});

// get the log file a given job. id passed as query param
app.get(routes.logger, function(req, res) {
	_file = crontab.log_folder +"/"+req.query.id+".log";
	if (fs.existsSync(_file))
		res.sendFile(_file);
	else
		res.end("No errors logged yet");
});

// error handler
app.use(function(err, req, res, next) {
	var data = {};
	var statusCode = err.statusCode || 500;

	data.message = err.message || 'Internal Server Error';

	if (process.env.NODE_ENV === 'development' && err.stack) {
		data.stack = err.stack;
	}

	if (parseInt(data.statusCode) >= 500) {
		console.error(err);
	}

	res.status(statusCode).json(data);
});

process.on('SIGINT', function() {
  console.log("Exiting crontab-ui");
  process.exit();
})

process.on('SIGTERM', function() {
  console.log("Exiting crontab-ui");
  process.exit();
})

// app listen on port HTTP
//app.listen(app.get('port'), app.get('host'), function() {
// app listen on port HTTPS
server.listen(app.get('https_port'), app.get('https_host'), function() {
  console.log("Node version:", process.versions.node);
  fs.access(__dirname + "/crontabs/", fs.W_OK, function(err) {
    if(err){
      console.error("Write access to", __dirname + "/crontabs/", "DENIED.");
      process.exit(1);
    }
  });
  // If --autosave is used then we will also save whatever is in the db automatically without having to mention it explictly
  // we do this by watching log file and setting a on change hook to it
  if (process.argv.includes("--autosave")){
    crontab.autosave_crontab(()=>{});
    fs.watchFile(__dirname + '/crontabs/crontab.db', () => {
      crontab.autosave_crontab(()=>{
        console.log("Attempted to autosave crontab");
      });
    });
  }
  if (process.argv.includes("--reset")){
    console.log("Resetting crontab-ui");
    var crontabdb = __dirname + "/crontabs/crontab.db";
    var envdb = __dirname + "/crontabs/env.db";

    console.log("Deleting " + crontabdb);
    try{
      fs.unlinkSync(crontabdb);
    } catch (e) {
      console.log("Unable to delete " + crontabdb);
    }

    console.log("Deleting " + envdb);
    try{
      fs.unlinkSync(envdb);
    } catch (e) {
      console.log("Unable to delete " + envdb);
    }

    crontab.reload_db();
  }
// print on console host and port to connect
//console.log("Crontab UI is running at http://" + app.get('host') + ":" + app.get('port'));
  console.log("Crontab UI is running at https://" + app.get('https_host') + ":" + app.get('https_port'));
});

// post logout
app.post(routes.logout, function(req, res) {
	console.log("Logout username " + app.get('username') + " browser " + req.body.browser_name);
	res.end();
});
