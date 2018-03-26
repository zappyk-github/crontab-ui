/*jshint esversion: 6*/
// include the constants
var constants = require("./constants").constants;
var tag_name = [constants.name, (process.env.CUI_PORT || constants.port), ''].join('-');

var tag_names = { crontab: __dirname + "/crontabs/" + tag_name + "crontab.db",
                  backups: __dirname + "/crontabs/" + tag_name + "backups/backup of: " };

//load database
var Datastore = require('nedb');
var path = require("path");
var db = new Datastore({ filename: tag_names['crontab'] });
var cronPath = "/tmp";
var progNode = constants.prog_node;


if(process.env.CRON_PATH !== undefined) {
	console.log(`Path to crond files set using env variables ${process.env.CRON_PATH}`);
	cronPath = process.env.CRON_PATH;
}

db.loadDatabase(function (err) {
	if (err) throw err; // no hope, just terminate
});

var exec = require('child_process').exec;
var fs = require('fs');
var cron_parser = require("cron-parser");

exports.log_folder = __dirname + "/crontabs/logs";
exports.env_file = __dirname + "/crontabs/" + tag_name + "env.db";

crontab = function(name, command, schedule, stopped, logging, mailing){
	var data = {};
	data.name = name;
	data.command = command;
	data.schedule = schedule;
	if(stopped !== null) {
		data.stopped = stopped;
	}
	data.timestamp = (new Date()).toString();
	data.logging = logging;
	if (!mailing)
		mailing = {};
	data.mailing = mailing;
	return data;
};

exports.create_new = function(name, command, schedule, logging, mailing){
	var tab = crontab(name, command, schedule, false, logging, mailing);
	tab.created = new Date().valueOf();
	db.insert(tab);
};

exports.update = function(data){
	db.update({_id: data._id}, crontab(data.name, data.command, data.schedule, null, data.logging, data.mailing));
};

exports.status = function(_id, stopped){
	db.update({_id: _id},{$set: {stopped: stopped}});
};

exports.remove = function(_id){
	db.remove({_id: _id}, {});
};

// Iterates through all the crontab entries in the db and calls the callback with the entries
exports.crontabs = function(callback){
	db.find({}).sort({ created: -1 }).exec(function(err, docs){
		for(var i=0; i<docs.length; i++){
			if(docs[i].schedule == "@reboot")
				docs[i].next = "Next Reboot";
			else
				docs[i].next = cron_parser.parseExpression(docs[i].schedule).next().toString();
		}
		callback(docs);
	});
};

exports.get_crontab = function(_id, callback) {
	db.find({_id: _id}).exec(function(err, docs){
		callback(docs[0]);
	});
};

// Set actual crontab file from the db
exports.set_crontab = function(env_vars, callback){
	exports.crontabs( function(tabs){
		var crontab_string = "";
		if (env_vars) {
			crontab_string = env_vars + "\n";
		}
		tabs.forEach(function(tab){
			if(!tab.stopped) {
				let tag_name = [constants.name, constants.port, tab._id].join('-');
				let stderr = path.join(cronPath, tag_name + ".stderr");
				let stdout = path.join(cronPath, tag_name + ".stdout");
				let log_file = path.join(exports.log_folder, tag_name + ".log");

				if(tab.command[tab.command.length-1] != ";") // add semicolon
					tab.command +=";";

				crontab_string += "\n#id: " + tab._id + " | " + tab.name + "\n";
				/*** replaced ***
				crontab_string += tab.schedule + " ({ " + tab.command + " } | tee " + stdout + ") 3>&1 1>&2 2>&3 | tee " + stderr;
				*/
			//	crontab_string += tab.schedule + "((( " + tab.command + " ) 2>&1 1>&3 | tee " + stderr + ") 3>&1 | tee " + stdout + ") > " + log_file + " 2>&1";
				crontab_string += tab.schedule + " (( " + tab.command + " ) 2>&1 1>&3 | tee " + stderr + ") 3>&1 | tee " + stdout;

				if (tab.logging && tab.logging == "true") {
					crontab_string += "; if test -f " + stderr +
					"; then date >> " + log_file +
					"; cat " + stderr + " >> " + log_file +
					"; fi";
				}

				if (tab.hook) {
					crontab_string += "; if test -f " + stdout +
					"; then " + tab.hook + " < " + stdout +
					"; fi";
				}

				if (tab.mailing && JSON.stringify(tab.mailing) != "{}"){
				//	crontab_string += "; /usr/local/bin/node " + __dirname + "/bin/crontab-ui-mailer.js " + tab._id + " " + stdout + " " + stderr;
					crontab_string += "; " + progNode + " " + __dirname + "/bin/crontab-ui-mailer.js " + tab._id + " " + stdout + " " + stderr;
				}

				crontab_string += "\n";
			}
		});

		fs.writeFile(exports.env_file, env_vars, function(err) {
			if (err) callback(err);
			// In docker we're running as the root user, so we need to write the file as root and not crontab
		//	var fileName = "crontab";
			var fileName = [constants.name, constants.port].join('-');
			if(process.env.CRON_IN_DOCKER !== undefined) {
				fileName = "root";
			}
			fs.writeFile(path.join(cronPath, fileName), crontab_string, function(err) {
				if (err) return callback(err);
				/// In docker we're running crond using busybox implementation of crond
				/// It is launched as part of the container startup process, so no need to run it again
				if(process.env.CRON_IN_DOCKER === undefined) {
				//	exec("crontab " + path.join(cronPath, "crontab"), function(err) {
					exec("crontab " + path.join(cronPath, fileName), function(err) {
						if (err) return callback(err);
						else callback();
					});
				} else {
					callback();
				}
			});
		});
	});
};

// run a job
exports.run_job = function(_id, callback){
		let job_id = _id;
		exports.get_crontab(job_id, function(job_db) {
			let job_env_vars = exports.get_env();
			let job_command  = job_db.command;
			let job_mailing  = job_db.mailing;
			let job_name     = job_db.name;
			let job_tag_name = [constants.name, constants.port, job_id, "runjob"].join('-');
                        
			let stderr = path.join(cronPath, job_tag_name + ".stderr");
			let stdout = path.join(cronPath, job_tag_name + ".stdout");
			let logjob = path.join(cronPath, job_tag_name + ".log");
			let runjob = path.join(cronPath, job_tag_name + ".sh");

			let job_file_string = "";
			if (job_env_vars) {
				job_file_string = job_env_vars + "\n\n";
			}
			job_file_string += "#id: " + job_id + " | " + job_name + "\n";
			job_file_string += "set -o pipefail\n";
		//	How do I save or redirect stdout and stderr into different files?
		//		https://www.cyberciti.biz/faq/saving-stdout-stderr-into-separate-files/
		//	job_file_string += "(( ( " + job_command + " ) 2>&1 1>&3 | tee " + stderr + ") 3>&1 1>&2 | tee " + stdout + ") > " + logjob + " 2>&1\n";
			job_file_string += " ( ( " + job_command + " ) 2>&1 1>&3 | tee " + stderr + ") 3>&1 1>&2 | tee " + stdout + "\n";
			job_file_string += "rt=$?\n";
			job_file_string += "\n";
			if (job_mailing && JSON.stringify(job_mailing) != "{}"){
				job_file_string += progNode + " " + __dirname + "/bin/crontab-ui-mailer.js " + job_id + " " + stdout + " " + stderr;
				job_file_string += "\n";
			}
			job_file_string += "exit $rt\n";
			fs.writeFile(runjob, job_file_string, function(err) {
				if (err) return callback(err);
				console.log("Run job: " + runjob + "\n\t# " + job_env_vars.replace(/\n/g, "\n\t#") + "\n\t# " + job_command);
				console.log("on date: " + new Date().toISOString());
				exec("bash " + runjob, function(err) {
					if (err) return callback(err);
					else callback();
				});
			});
		});
};

exports.get_backup_names = function(){
	var backups = [];
//	var bakname = "backup";
	var bakname = path.basename(tag_names['backups']);
        var bakpath = path.dirname(tag_names['backups']);
//	fs.readdirSync(__dirname + '/crontabs').forEach(function(file){
	fs.readdirSync(bakpath).forEach(function(file){
		// file name begins with backup
		if(file.indexOf(bakname) === 0){
			backups.push(file);
		}
	});

	// Sort by date. Newest on top
	for(var i=0; i<backups.length; i++){
		var Ti = backups[i].split(bakname)[1];
		Ti = new Date(Ti.substring(0, Ti.length-3)).valueOf();
		for(var j=0; j<i; j++){
			var Tj = backups[j].split(bakname)[1];
			Tj = new Date(Tj.substring(0, Tj.length-3)).valueOf();
			if(Ti > Tj){
				var temp = backups[i];
				backups[i] = backups[j];
				backups[j] = temp;
			}
		}
	}

	return backups;
};

exports.backup = function(){
	//TODO check if it failed
	var bakname = tag_names['backups'] + (new Date()).toString().replace("+", " ") + '.db';
        var bakpath = path.dirname(bakname);
	if (!fs.existsSync(bakpath)){
		fs.mkdirSync(bakpath);
	}
	console.log("Create %s", path.basename(bakname));
	fs.createReadStream(tag_names['crontab']).pipe(fs.createWriteStream(bakname));
};

exports.restore = function(db_name){
	fs.createReadStream(__dirname + '/crontabs/' + db_name).pipe(fs.createWriteStream(tag_names['crontab']));
	db.loadDatabase(); // reload the database
};

exports.reload_db = function(){
	db.loadDatabase();
};

exports.get_env = function(){
	if (fs.existsSync(exports.env_file)) {
		return fs.readFileSync(exports.env_file , 'utf8').replace("\n", "\n");
	}
	return "";
};

exports.import_crontab = function(){
	exec("crontab -l", function(error, stdout, stderr){
		var lines = stdout.split("\n");
		var namePrefix = new Date().getTime();

		lines.forEach(function(line, index){
			line = line.replace(/\t+/g, ' ');
			var regex = /^((\@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
			var command = line.replace(regex, '').trim();
			var schedule = line.replace(command, '').trim();

			var is_valid = false;
			try { is_valid = cron_parser.parseString(line).expressions.length > 0; } catch (e){}

			if(command && schedule && is_valid){
				var name = namePrefix + '_' + index;

				/*** replaced ***
				db.findOne({ command: command, schedule: schedule }, function(err, doc) {
					if(err) {
						throw err;
					}
					if(!doc){
						exports.create_new(name, command, schedule, null);
					}
					else{
						doc.command = command;
						doc.schedule = schedule;
						exports.update(doc);
					}
				});
				*/
				db.find({}).exec(function(err, docs){
					var find_update = false;
					for(var i=0; i<docs.length; i++){
						if(command.indexOf(docs[i].command) >= 0) {
							find_update = true;
							db.findOne({ command: command }, function(err, doc) {
								if(err) {
									throw err;
								}
								if(doc){
									doc.schedule = schedule;
									exports.update(doc);
								}
							});
						}
					}
					if(!find_update){
						exports.create_new(name, command, schedule, null);
					}
				});
			}
		});
	});
};

exports.autosave_crontab = function(callback) {
	let env_vars = exports.get_env();
	exports.set_crontab(env_vars, callback);
};
