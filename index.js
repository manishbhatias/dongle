#!/usr/bin/env node

var moment = require("moment");
var events = require("events");
var modem = require("modem");
var fs = require("fs");

function dongle(device) {
    var self = this;

    // check if modem exists
    if (!fs.existsSync(device)) {
        process.nextTick(function() {
            self.emit("error", new Error("Device does not exist: " + device));
        });
        return self;
    }

    self.modem = new modem.Modem();
    self.open = false;
    self.modem.open(device, function() {
        self.open = true;
        self.send("AT", function(err, status, data) {
            if (err) return self.emit("error", err);
            if (status !== "OK") return self.emit("error", "AT returned " + status);
            self.prepare(function(err) {
                if (err) return self.emit("error", err);
                self.check();
            });
        });
        self.modem.on("error", function(err) {
            return self.emit("error", err);
        });
        self.modem.on("close", function(err) {
            if (self.open) {
                self.open = false;
                self.emit("close");
                try {
                    self.modem.close();
                } catch (e) {
                    return self.emit("error", e);
                }
            }
        });
    });
    return this;
};

/* clone prototype from event emitter */
dongle.prototype = Object.create(events.EventEmitter.prototype);

dongle.prototype.send = function(command, callback, iteration) {
    var iteration = (!iteration) ? 0 : iteration;
    if (iteration >= 5) return callback(new Error("SIM does not reply"));
    var self = this;
    self.modem.execute(command, function(data, status) {
        status = (typeof status === "string") ? status.trim() : false;
        data = (typeof data === "string") ? data.trim() : "";
        if (status === "+CME ERROR: SIM busy") {
            self.emit("sim-busy");
            return setTimeout(function() {
                self.send(command, callback, iteration++);
            }, 500);
        };
        self.emit("command", command, data, status);
        callback(null, status, data);
    }, false, 500);
};

dongle.prototype.prepare = function(callback) {
    var self = this;
    // enable cell id
    self.send("AT+CREG=2", function(err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("AT+CREG=2 failed: " + status + " " + data));
        // enable numeric operator format
        self.send("AT+COPS=3,2", function(err, status, data) {
            if (err) return callback(err);
            if (status !== "OK") return callback(new Error("AT+COPS=3,2 failed: " + status + " " + data));
            callback(null);
        });
    });
};

// check get all information and compile it 
dongle.prototype.check = function() {
    var self = this;
    self.imsi(function(err, imsi) {
        if (err) return self.emit("error", err);
        self.imsi = imsi;
        self.imei(function(err, imei) {
            if (err) return self.emit("error", err);
            self.imei = imei;
            self.signalstrength(function(signal_err, signal) {
                if (signal_err) self.emit("error-signal", signal_err);
		self.signal = signal;
                self.cellid(function(cellid_err, cellid) {
                    if (cellid_err) self.emit("error-cellid", cellid_err);
		    self.cellid = cellid;
                    self.service(function(service_err, service) {
                        if (service_err) self.emit("error-service", service_err);
			self.service = service;
                        self.subscriberid(function(err, subscriberid) {
                            if (err) return self.emit("error", err);
                            self.subscriberid = subscriberid;
                            self.emit("data", {
                                imsi: self.imsi,
                                imei: self.imei,
                                subscriberid: self.subscriberid,
                                signal: self.signal,
                                cell: self.cellid,
                                service: self.service,
                            });
			    self.modem.close();
                        });
                    });
                });
            });
        });
    });
};

dongle.prototype.imsi = function(callback) {
    var self = this;
    self.send("AT+CIMI", function(err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed AT+CIMI"));
        var result = (data.match(/^([0-9]{6,15})$/));
        if (!result) return callback(new Error("Failed AT+CIMI"));
        callback(null, parseInt(result[1], 10));
    });
};

dongle.prototype.imei = function(callback) {
    var self = this;
    self.send("AT+CGSN", function(err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed AT+CGSN"));
        var result = (data.match(/^([0-9]{14,15})/));
        if (!result) return callback(new Error("Failed AT+CGSN"));
        callback(null, parseInt(result[1], 10));
    });
};

dongle.prototype.signalstrength = function(callback){
	var self = this;
	self.send("AT+CSQ", function(err, status, data){
		if (err) return callback(err);
		if (status !== "OK") return callback(new Error("Failed AT+CSQ"));
		var signal = (data.match(/^\+CSQ: ([0-9]{1,2}),99$/));
		if (!signal) return callback(new Error("Failed AT+CSQ"));
		if (signal[1] === "99") return callback(null, -Infinity);
		callback(null, (-113+(parseInt(signal[1],10)*2)));
	});
};

dongle.prototype.service = function(callback){
	var self = this;
	self.send("AT+COPS?", function(err, status, data){
		if (err) return callback(err);
		if (status !== "OK") return callback(new Error("Failed Request AT+CREG?"));
		var result = data.match(/^\+COPS: ([0-4])(,([0-2]),"([^"]+)"(,([0-7]))?)?$/);
		if (!result) return callback(new Error("Parse Error AT+COPS?"));
		callback(null, {
			operator: (typeof result[4] === "string") ? result[4] : null,
			mode: (typeof result[6] === "string") ? parseInt(result[6],10) : null
		});
	});
};

dongle.prototype.cellid = function(callback) {
    var self = this;
    self.send("AT+CREG?", function(err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed Request AT+CREG?"));
        var cellid = data.match(/^\+CREG: ([0-2]),([0-5])(, ?([0-9A-F]+), ?([0-9A-F]+)(, ?([0-7]))?)?$/);
        if (!cellid) return callback(new Error("Parse Error AT+CREG?"));
        callback(null, {
            stat: parseInt(cellid[2], 10),
            lac: (typeof cellid[4] === "string") ? parseInt(cellid[4].toLowerCase(), 16) : null,
            cell: (typeof cellid[5] === "string") ? parseInt(cellid[5].toLowerCase(), 16) : null,
            act: (typeof cellid[7] === "string") ? parseInt(cellid[7], 10) : null
        });
    });
};

dongle.prototype.subscriberid = function(callback) {
    var self = this;
    var ussd = new modem.Ussd_Session();
    ussd.modem = self.modem;
    ussd.callback = callback;
    ussd.parseResponse = function(response_code, message) {
        this.close();
	var match = message.match(/(\d{10})/);
	if(!match) {
            if(this.callback)
                this.callback(new Error("Parse Error AT+CUSD"));
            return ;
        }
        if(this.callback)
            this.callback(null,match[1]);
    }

    ussd.execute = function() {
        self.modem.ussd_pdu = false;
	this.query('*282#', ussd.parseResponse);
    }

    ussd.start();
    self.modem.ussd_pdu = true;
};

module.exports = dongle;

if (require.main === module) {
    var device = process.argv[2];
    if (!device) console.log('Error Please provide a device!');

    var d = new dongle(device);
    d.on('data', function(r) {
        console.log(arguments)
    });
    d.on('error', function(r) {
        console.log(arguments)
    });
}
