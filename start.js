const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const browserify = require('browserify');
const exorcist = require('exorcist');
const sourceMap = require('source-map');
const dnsd = require('dnsd');
const ip = require('ip');
const express = require('express');
const bodyParser = require('body-parser');
const mkdirp = require('mkdirp');
const blessed = require('blessed');
const contrib = require('blessed-contrib');
const yargs = require('yargs');
// const dnslookup = require('dns')

let argv = yargs
	.usage('Usage $0')
	.describe('enable-curses', 'Enable curses interface.')
	.describe('disable-dns', 'Disables builtin DNS server.')
	.describe('ip', 'Override IP address DNS server responds with')
	.describe('host', 'Override listen IP.')
	.describe('logfile', 'Writes debug log to file')
	.describe('setuid', 'Sets UID after binding ports (drop root priveleges)')
	.example('$0 --ip 1.2.4.8 --logfile debug.txt --setuid 1000')
	.help('h')
	.nargs('ip', 1)
	.nargs('host', 1)
	.nargs('logfile', 1)
	.nargs('setuid', 1)
	.alias('h', 'help')
	.argv;

if(os.platform() === 'win32') {
	if(argv['enable-curses']) {
		console.warn('WARNING: pegaswitch does not support curses on Windows. Curses disabled by default.');
		argv['enable-curses'] = false;
	}

} else if (process.getuid() !== 0) {
	console.error('Please run as root so we can bind to port 53 & 80');
	process.exit();
}	
	
if (!argv['enable-curses'] && !argv.logfile) {
	argv.logfile = 'pegaswitch.log'
	console.warn('With curses disabled, a logfile (--logfile) is required. Defaulting to \"pegaswitch.log\".');
}

let logf = {
	log: function (data) {
		if (!argv.logfile) {
			return;
		}
		fs.writeFileSync(path.resolve(__dirname, argv.logfile), `${data}\n`, {
			flag: 'a'
		});
	}
};


let dnsServerStarted;
let httpServerStarted;

let ipAddr = argv.ip || ip.address();
if (argv['disable-dns'] !== true) {
  
	// Spin up our DNS server
	let dns = dnsd.createServer(function (req, res) {
		res.end(ipAddr);
	});

	dnsServerStarted = new Promise((resolve, reject) => {
		dns.on('error', function (err) {
			console.log(`There was an issue setting up DNS: ${err.message}`);
			reject();
			process.exit();
		});

		dns.listen(53, argv.host || '0.0.0.0', () => {
			resolve();
		});
	});
} else {
	dnsServerStarted = Promise.resolve();
}

// Web server
const app = express();
app.use(bodyParser.json());

function serveIndex (req, res) {
	res.end(fs.readFileSync(path.resolve(__dirname, 'exploit/index.html')));
}

var fakeInternetEnabled = false;

app.get('/', function (req, res) {
	if (fakeInternetEnabled) {
		res.set('X-Organization', 'Nintendo');
	}
	serveIndex(req, res);
});

app.get('/minmain.js', function (req, res) {
	if ((req.headers['user-agent'].indexOf('NF/4.0.0.8.9 ') !== -1)
		|| (req.headers['user-agent'].indexOf('NF/4.0.0.9.3 ') !== -1)
		|| (req.headers['user-agent'].indexOf('NF/4.0.0.10.13 ') !== -1))
	{
		res.end(fs.readFileSync(path.resolve(__dirname, 'exploit/minmain_5.0.0-6.0.1.js')));
	} else {
		res.end(fs.readFileSync(path.resolve(__dirname, 'exploit/minmain_1.0.0-4.1.0.js')));
	}
});

app.get('/fake_news.mp', function (req, res) {
	var u8 = new Uint8Array(fs.readFileSync(path.resolve(__dirname, 'files/fake_news.mp')));
	res.end(JSON.stringify(Array.prototype.slice.call(u8)));
});

app.get('/nros/:nroname', function (req, res) {
  var u8 = new Uint8Array(fs.readFileSync(path.resolve(__dirname, 'nros', req.params.nroname)));
  res.end(JSON.stringify(Array.prototype.slice.call(u8)));
});

app.get('/cache', function (req, res) {
	var md5 = crypto.createHash('md5');
	md5.update(req.headers['user-agent']);
	md5 = md5.digest('hex');
	var fn = path.resolve(__dirname, 'gadgetcaches/' + md5 + '.json');
	if (fs.existsSync(fn)) {
		res.end(fs.readFileSync(fn));
	} else {
		res.end('{}');
	}
});

const sourceMapPath = path.join(__dirname, 'sourcemap');

app.get('/bundle.js', function (req, res) {
	// make sure config file exists
	try {
		fs.statSync("config.json"); // test existence
	} catch(e) {
		var config = { // default config
		};
		fs.writeFileSync("config.json", JSON.stringify(config), "utf-8");
	}
  
	browserify({
		entries: [ 'exploit/main.js' ],
		cache: {},
		packageCache: {},
		debug: true
	}).bundle()
		.pipe(exorcist(sourceMapPath))
		.pipe(res);
});

let failures = 0;
let successes = 0;

app.post('/log', function (req, res) {
	let message = req.body.msg;

	if (message === 'Loaded' && (successes !== 0 || failures !== 0)) {
		logger.log(`Success percentage: ${(successes / (successes + failures) * 100).toFixed(2)} (${successes + failures} samples)`);
	} else if (message === '~~failed') {
		failures++;
	} else if (message === '~~success') {
		successes++;
	} else {
		logger.log(message);
		logf.log(message);
	}

	return res.sendStatus(200);
});

app.post('/cache', function (req, res) {
	var md5 = crypto.createHash('md5');
	md5.update(req.headers['user-agent']);
	md5 = md5.digest('hex');
	var fn = path.resolve(__dirname, 'gadgetcaches/' + md5 + '.json');
	let cache = req.body.msg;
	fs.writeFileSync(fn, JSON.stringify(cache));
	return res.sendStatus(200);
});

app.post('/error', function (req, res) {
	logger.log(`ERR [${req.body.msg[0]}]: ${req.body.msg[1]}`);
	logf.log(`ERR [${req.body.msg[0]}]: ${req.body.msg[1]}`);
	if (req.body.msg[2]) {
		let smc = new sourceMap.SourceMapConsumer(JSON.parse(fs.readFileSync(sourceMapPath, 'utf8')));
		let lines = req.body.msg[2].split('\n');
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i].trim();
			if (line === 'eval code') {
				logger.log('eval code');
				logf.log('eval code');
				break;
			}
			if (line.includes('@')) {
				let parts = line.split('@');
				let fcnname = parts[0];
				parts = parts[1].split(':');
				let lineno = parseInt(parts[parts.length - 2]);
				let columnno = parseInt(parts[parts.length - 1]);

				let original = smc.originalPositionFor({line: lineno, column: columnno});
				logger.log(fcnname + '@' + original.source + ':' + original.line + ':' + original.column);
				logf.log(fcnname + '@' + original.source + ':' + original.line + ':' + original.column);
			} else {
				logger.log(line);
				logf.log(line);
			}
		}
	}
	return res.sendStatus(200);
});

app.post('/filedump', function (req, res) {
	let name = 'dumps/' + req.get('Content-Disposition').replace(':', '');
	let dir = path.dirname(name);

	try {
		fs.statSync(dir);
	} catch (e) {
		mkdirp.sync(dir);
	}
	req.pipe(fs.createWriteStream(name, {
		defaultEncoding: 'binary',
		flags: 'a'
	}));

	req.on('end', function() {
		return res.sendStatus(200);
	});
});

app.post('/fakeInternet', function (req, res) {
	console.log('toggling fake internet');
	fakeInternetEnabled = !fakeInternetEnabled;
});

httpServerStarted = new Promise((resolve, reject) => {
	app.listen(80, argv.host || '0.0.0.0', function (err) {
		if (err) {
			console.error('Could not bind to port 80');
			reject();
			process.exit(1);
		} else {
			resolve();
		}
	});
});

Promise.all([dnsServerStarted, httpServerStarted]).then(() => {
	if (argv['setgid'] !== undefined) {
		process.setgid(argv['setgid']);
		if(process.getgid() === 0) {
			console.log('Failed to drop privileges');
			process.exit(1);
		}
	}
	
	if (argv['webapplet'] !== undefined) {
		fakeInternetEnabled = true;
	}
  
	if (argv['setuid'] !== undefined) {
		if (argv['setgid'] === undefined) {
			process.setgid(argv['setuid']);
			if(process.getgid() === 0) {
				console.log('Failed to drop privileges');
				process.exit(1);
			}
		}
		process.setuid(argv['setuid']);
		if(process.getuid() === 0) {
			console.log('Failed to drop privileges');
			process.exit(1);
		}
	}

	if (!argv['enable-curses']) {
		console.log("Responding with address " + ipAddr);
		console.log("Switch DNS IP: " + (argv.host || ip.address()) + " (Use this to connect)");
		require('./repl');
		logger = logf;
		logf = {log: function() {}};
	} else {
		// Setup our terminal
		let screen = blessed.screen({
			smartCSR: true
		});

		let log = contrib.log({
			parent: screen,
			fg: 'green',
			selectedFg: 'green',
			label: 'Debug Log',
			border: 'line',
			width: '30%',
			height: '100%',
			left: '70%',
			style: {
				fg: 'default',
				bg: 'default',
				focus: {
					border: {
						fg: 'green'
					}
				}
			}
		});

		logger = log;

		let repl = blessed.terminal({
			parent: screen,
			cursor: 'line',
			cursorBlink: true,
			screenKeys: false,
			label: 'REPL',
			left: 0,
			top: 0,
			width: '70%',
			height: '100%',
			border: 'line',
			style: {
				fg: 'default',
				bg: 'default',
				focus: {
					border: {
						fg: 'green'
					}
				}
			},
			shell: path.resolve(__dirname, 'repl.js')
		});

		repl.on('exit', function () {
			process.exit();
		});

		screen.append(log);
		screen.append(repl);

		repl.focus();

		// Render everything
		screen.render();

		//Output ip addresses
		repl.write("Responding with address " + ipAddr + "\r\n");
		repl.write("Switch DNS IP: " + (argv.host || ip.address()) + " (Use this to connect)");	
	}

}, (e) => {
	console.log("rejected " + e);
	console.log(e.stack);
});
