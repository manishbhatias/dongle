#!/usr/bin/env node

var serialport = require('serialport');
var Q = require('q');
var events = require("events");
var modem = require("modem");
var fs = require("fs");

function dongle() {
    this.info = {};
    this.info_commands = ['imsi', 'imei', 'signalstrength', 'cellid', 'service', 'subscriberid'];
    return this;
};

/* clone prototype from event emitter */
dongle.prototype = Object.create(events.EventEmitter.prototype);

dongle.prototype.scanModem = function (callback) {
    var self = this;

    // list serial ports:
    serialport.list(function (err, ports) {
        if (err) {
            console.log('Unable to list ports! ' + err);
            return callback(false);
        }
        self.checkModem(ports, callback);
    });
};

dongle.prototype.checkModem = function (ports, callback) {
    var self = this;
    var port = ports.shift();
    if (!port) {
        console.log('No device found!');
        return callback(false);
    }
    console.log('Scanning port ' + port.comName);
    self.init(port.comName, function (err, modem) {
        if (err) {
            self.checkModem(ports, callback);
        } else {
            console.log('Found modem at ' + modem);
            callback(modem);
        }

    });
}

dongle.prototype.send = function (command, callback, iteration) {
    var iteration = (!iteration) ? 0 : iteration;
    if (iteration >= 1) return callback(new Error("SIM does not reply"));
    var self = this;
    return self.modem.execute(command, function (data, status) {
        status = (typeof status === "string") ? status.trim() : false;
        data = (typeof data === "string") ? data.trim() : "";
        if (status === "+CME ERROR: SIM busy") {
            self.emit("sim-busy");
            return setTimeout(function () {
                self.send(command, callback, iteration++);
            }, 500);
        };
        self.emit("command", command, data, status);
        callback(null, status, data);
    }, false, 500);
};

dongle.prototype.init = function (device, callback) {
    var self = this;
    self.device = device;
    self.modem = new modem.Modem();
    self.open = false;
    self.modem.open(device, function () {
        self.open = true;
        self.send("AT", function (err, status, data) {
            if (err) return callback(err);
            if (status !== "OK") return callback(new Error("AT returned " + status));
            return self.prepare(function () {
                callback(null, device);
            });
        }).on('timeout', function () {
            callback(new Error("AT did not return!"));
        });
        self.modem.on("error", function (err) {
            return self.emit("error", err);
        });
        self.modem.on('sms received', function (smsinfo) {
            self.emit('sms-received', smsinfo);
        });
        self.modem.on("close", function (err) {
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
};

// Get all information and compile it 
dongle.prototype.check = function (callback) {
    var self = this;
    var deferreds = self.info_commands.map(function (command) {
        var q = Q.defer();
        self[command](function (err, res) {
            if (!err) {
                self.info[command] = res;
                q.resolve(res);
            } else {
                console.log(err);
            }
        });
        return q.promise;
    });
    Q.all(deferreds).then(function (res) {
       callback(self.info);
    });
};

dongle.prototype.prepare = function (callback) {
    var self = this;
    self.send("AT+CTZU=1", function (err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("AT+CTZU=1 failed: " + status + " " + data));

        // enable cell id
        self.send("AT+CREG=2", function (err, status, data) {
            if (err) return callback(err);
            if (status !== "OK") return callback(new Error("AT+CREG=2 failed: " + status + " " + data));
            // enable numeric operator format
            self.send("AT+COPS=3,2", function (err, status, data) {
                if (err) return callback(err);
                if (status !== "OK") return callback(new Error("AT+COPS=3,2 failed: " + status + " " + data));
                callback(null);
            });
        });
    });
}

dongle.prototype.imsi = function (callback) {
    var self = this;
    self.send("AT+CIMI", function (err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed AT+CIMI"));
        var result = (data.match(/^([0-9]{6,15})$/));
        if (!result) return callback(new Error("Failed AT+CIMI"));
        callback(null, parseInt(result[1], 10));
    });
};

dongle.prototype.imei = function (callback) {
    var self = this;
    self.send("AT+CGSN", function (err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed AT+CGSN"));
        var result = (data.match(/^([0-9]{14,15})/));
        if (!result) return callback(new Error("Failed AT+CGSN"));
        callback(null, parseInt(result[1], 10));
    });
};

dongle.prototype.networktime = function (callback) {
    var self = this;
    self.send("AT+CCLK?", function (err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed AT+CCLK"));
        var result = (data.match(/^\+CCLK: \"(.+)\"/));
        if (!result) return callback(new Error("Failed AT+CCLK"));
        callback(null, result[1]);
    });
};

dongle.prototype.signalstrength = function (callback) {
    var self = this;
    self.send("AT+CSQ", function (err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed AT+CSQ"));
        var signal = (data.match(/^\+CSQ: ([0-9]{1,2}),99$/));
        if (!signal) return callback(new Error("Failed AT+CSQ"));
        if (signal[1] === "99") return callback(null, -Infinity);
        callback(null, (-113 + (parseInt(signal[1], 10) * 2)));
    });
};

dongle.prototype.service = function (callback) {
    var self = this;
    self.send("AT+COPS?", function (err, status, data) {
        if (err) return callback(err);
        if (status !== "OK") return callback(new Error("Failed Request AT+CREG?"));
        var result = data.match(/^\+COPS: ([0-4])(,([0-2]),"([^"]+)"(,([0-7]))?)?$/);
        if (!result) return callback(new Error("Parse Error AT+COPS?"));
        callback(null, {
            operator: (typeof result[4] === "string") ? result[4] : null,
            mode: (typeof result[6] === "string") ? parseInt(result[6], 10) : null
        });
    });
};

dongle.prototype.cellid = function (callback) {
    var self = this;
    self.send("AT+CREG?", function (err, status, data) {
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

dongle.prototype.subscriberid = function (callback) {
    var self = this;
    var ussd = new modem.Ussd_Session();
    ussd.modem = self.modem;
    ussd.callback = callback;
    ussd.parseResponse = function (response_code, message) {
        this.close();
        var match = message.match(/(\d{10})/);
        if (!match) {
            if (this.callback)
                this.callback(new Error("Parse Error AT+CUSD"));
            return;
        }
        if (this.callback)
            this.callback(null, match[1]);
    }

    ussd.execute = function () {
        self.modem.ussd_pdu = false;
        this.query('*282#', ussd.parseResponse);
    }

    ussd.start();
    self.modem.ussd_pdu = true;
};

/*
 *    Send an SMS using the dongle.
 *    @param message Object
 *        text String message body. Longs messages will be splitted and sent in multiple parts transparently.
 *        receiver String receiver number.
 *        encoding String. '16bit' or '7bit'. Use 7bit in case of English messages.
 *    @param callback Fucntion(err, references) is called when sending is done.
 *
 *    @return references Array contains reference ids for each part of sent message.
 */

dongle.prototype.sendsms = function (message) {
    var self = this;
    message.encoding = (message.encoding !== '7bit') ? '16bit' : '7bit';
    this.modem.sms(message, function () {});
};

module.exports = dongle;

if (require.main === module) {
    var d = new dongle();
    var device = process.argv[2];
    if (!device || !fs.existsSync(device)) {
        console.log('No device provided! Scanning for devices');
        d.scanModem(function (modem) {
            if (!modem) process.exit(-1);

            //Handler for receiving SMS
            d.on('sms-received', function (smsinfo) {
                console.log(smsinfo);
                /*
                d.sendsms({
                    'text': smsinfo.text,
                    'receiver': smsinfo.sender.slice(-10)
                });
                */
            });
            //Do some work here like getting information or sending an SMS
            d.check(function(r){
                console.log(r);
            });
            /*
            d.sendsms({
                'text': 'Test SMS from PressPlay. Reply to this SMS and we will echo back',
                'receiver': '9990917017'
            });
            */
        });
    } else {
        d.init(device, function () {
            d.check(function(r){
                console.log(r);
            });
        });
    }
}