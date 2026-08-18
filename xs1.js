/* eslint-disable no-await-in-loop */
/**
 *
 * EZcontrol XS1 Adapter
 * v0.4.5 with Promises and requires ES6
 */
/* eslint-env node,es6 */
/* jshint -W097 */ // jshint strict:false
/*jslint node: true */
"use strict";

//var request =       require('request');
//const util =          require('util');
const http = require('http');
const A = require('./myAdapter').MyAdapter;
const EventEmitter = require('events').EventEmitter;


class MyXS1 extends EventEmitter {
    constructor() {
        super();

        this.url = null;
        this.names = new Map();
        this.creq = null;
        this.resp = null;
        this.connected = false;

        this._timeoutTime = 4 * 60 * 1000; // 4 Minutes default timeout
        this._triggerTime = 60 * 1000;
        this._watchdog = null;
        this._toggle = false;
        this._trigger = null;
        this._triggerFun = null;

        this.roles = {
            "switch": ["switch", "timerswitch", "sound", "remotecontrol"],
            "sensor": ["door", "doorbell", "dooropen", "motion", "waterdetector", "window"],
            "value.temperature": ["temperature", "number"],
            "value.brightness": ["light", "dimmer"],
            "value.humidity": ["hygrometer"],
            "value": ["counter", "pwr_consump", "rainintensity"],
            "direction": ["winddirection"],
            "value.speed": ["windspeed"],
            "level.blind": ["shutter"],
        };


        this.types = {
            "boolean": ["switch", "sensor"]
        };
    }

    stop() {
        this.disconnect();
        this.resetXS1();
    }

    update() {
        A.D(`Watchdog updated`);
        if (this._watchdog)
            clearTimeout(this._watchdog);
        this._watchdog = setTimeout(this.stop.bind(this), this._timeoutTime);
    }

    start(trigger, triggertime, timeout) {
        const self = this;
        if (timeout)
            this._timeoutTime = parseInt(timeout);
        if (triggertime)
            this._triggerTime = parseInt(triggertime);
        if (typeof trigger === 'function') {
            this._triggerFun = () => {
                self._toggle = !self._toggle;
                trigger(self._toggle);
            };
            this._trigger = setInterval(this._triggerFun, this._triggerTime);
        }
        this.update();
    }

    resetXS1() {
        this.url = null;
        this.names = new Map();
        this.creq = null;
        this.resp = null;
        this.connected = false;
        if (this._watchdog)
            clearTimeout(this._watchdog);
        this.removeAllListeners();
    }

    static findItem(l, i) {
        for (var s in l)
            if (l[s].indexOf(i) >= 0)
                return s;
        return null;
    }

    getRole(vtype) {
        return MyXS1.findItem(this.roles, vtype);
    }

    getType(vtype) {
        const role = this.getRole(vtype);
        let type = 'number';
        if (role) {
            let typ = MyXS1.findItem(this.types, role);
            if (typ)
                type = typ;
        }
        return type;
    }

    disconnect() {
        if (!this.connected) {
            //           this.emit("error", "XS1 disconnect called on not connected device!");
            return;
        }
        if (this.creq)
            this.creq.abort();
        this.connected = false;
        this.resp = null;
        this.creq = null;
        this.emit('disconnected');
    }

    sendXS1(command) {
        const that = this;
        let url = this.url + "control?callback=cb&x=" + Date.now() % 1000000 + "&cmd=" + command;
        return A.get(url, 2)
            .then(rawData => {
                let data;
                try {
                    data = rawData.trim();
                    data = data.slice(data.indexOf('(') + 1, -1);
                    data = A.J(data);
                } catch (e) {
                    data = A.J('x');
                }
                return data;
            })
            .then(obj => {
                if (obj.error > "") {
                    that.emit('error', "sendXS1 returned ERROR: " + obj.error + ", " + that.link);
                    return A.reject(obj.error);
                }
                let t = null;
                if (/actuator/.test(command))
                    t = "actuator";
                else if (/sensor/.test(command))
                    t = "sensor";
                else {
                    that.emit('error', command + "= unknown object result from XS1");
                    obj = [];
                }
                if (t && obj[t])
                    obj = obj[t];

                if (Array.isArray(obj)) {
                    const na = [];
                    for (var key = 0; key < obj.length; ++key) {
                        if (obj[key].type != "disabled") {
                            obj[key].styp = t;
                            obj[key].lname = (t === 'sensor' ? 'Sensors.' : 'Actuators.') + obj[key].name;
                            obj[key].number = key + 1;
                            na.push(obj[key]);
                        }
                    }
                    obj = na;
                }
                return A.resolve(obj);
            })
            .catch(err => {
                that.emit('error', err);
                throw err;
            });
        //      });
    }

    setState(name, value) {
        if (!this.names.has(name)) {
            let err = `MyXS1.setState Name not found: ${name}`;
            this.emit("error", err);
            return A.reject(err);
        }
        const item = this.names.get(name);
        const id = item.number || 0;
        const styp = item.styp;
        let val = parseFloat(value);

        if (styp === "actuator") {
            if (typeof value === "boolean") {
                val = value ? 100 : 0;
            } else if (typeof value === "number") {
                val = value > 100 ? 100 : (value <= 0 ? 0 : parseInt(value));
            } else val = parseInt(value);
        }

        // XS1 shutters can expose dedicated functions for the end positions.
        // Using these functions retriggers the physical movement even if the XS1
        // already reports the same logical position (e.g. value is already 100%).
        if (styp === "actuator" && item.type === "shutter" && (val === 0 || val === 100) && Array.isArray(item.function)) {
            const target = `${val}%`;
            const functionIndex = item.function.findIndex(fn =>
                fn && typeof fn.dsc === "string" && fn.dsc.trim() === target
            );

            if (functionIndex >= 0) {
                const xs1Function = functionIndex + 1;
                A.I(`XS1 shutter endpoint ${name}: ${val}% -> function=${xs1Function}`);
                return this.sendXS1(`set_state_${styp}&number=${id}&function=${xs1Function}`);
            }
        }

        return this.sendXS1(`set_state_${styp}&number=${id}&value=${val}`);
    }

    startXS1(url) {
        const that = this;
        if (!url || !url.startsWith("http"))
            return A.reject(this.emit('error', 'not a valid URL for XS1:' + url));

        if (url.substr(-1, 1) !== '/')
            url = url + '/';
        if (this.connected) {
            this.emit("error", "XS1 connect called on already connected device!");
            return A.reject("XS1 already connected");
        }

        this.url = url;
        this.names = new Map();

        return A.wait(10)
            .then(() => {
                const url = that.url + "control?callback=cb&cmd=subscribe&format=txt&x=" + Date.now();
                try {
                    that.creq = http.get(url, function (response) {
                        that.resp = response;
                        if (response.statusCode != 200) {
                            that.emit('error', response.statusCode);
                            return A.reject("Bad status code for connection:" + response.statusCode);
                        }
                        response.setEncoding('utf8');

                        response.on('data', buf => {
                            const b = buf.trim().split(' ');
                            if (b.length < 14)
                                return that.emit("error", {
                                    err: "Invalid response from XS1 data",
                                    value: buf
                                }, "warn");
                            let data = {};
                            const st = {
                                'A': "Actuators",
                                'S': "Sensors"
                            };
                            try {
                                data.ts = parseInt(b[0]) * 1000;
                                data.lname = st[b[9]];
                                data.number = b[10];
                                data.name = b[11];
                                data.vtype = b[12];
                                data.val = parseFloat(b[13]);
                                if (myXS1.getType(data.vtype) === "boolean")
                                    data.val = (data.val === 0 || data.val === false) ? false : !!data.val;
                            } catch (e) {
                                return that.emit("error", {
                                    err: "Cannot read response from XS1 data",
                                    value: buf,
                                    arrcode: e
                                }, "warn");
                            }
                            that.emit('data', data);
                        });
                        response.on('error', err => that.emit('error', err, 'error resp in XS1'));
                        response.on('end', () => {
                            that.creq = null;
                            that.resp = null;
                            that.connected = false;
                            that.emit('disconnected');
                        });
                        that.connected = true;
                        that.emit('connected', response.statusCode);
                        return A.resolve();
                    }).on('aborted', function () {
                        if (that.connected)
                            that.emit('disconnected');
                        that.connected = false;
                        that.creq = null;
                        that.resp = null;
                    }).on('error', err => that.emit('error', err, 'error creq in XS1'));

                } catch (e) {
                    if (that.creq)
                        that.creq.abort();
                    that.connected = false;
                    that.resp = null;
                    that.creq = null;
                    that.emit('error', e);
                    throw e;
                }
            });
    }

}

// you have to require the utils module and call adapter function
A.init(module, 'xs1', main);

const myXS1 = new MyXS1();
var copylist = {};

// is called if a subscribed state changes
A.stateChange = (id, state) => {
    // Warning, state can be null if it was deleted
    A.D('stateChange ' + id + ' to ' + state.val);
    const idn = id.split('.');
    const name = idn[idn.length - 1];
    //        const obj = myXS1.names.get(name);
    if (idn[idn.length - 2] !== "Actuators")
        return A.reject(A.W("XS1 cannot set state of Sensor " + name + " to " + A.O(state)));
    else
        return myXS1.setState(name, state.val);
};


A.unload = () => {
    myXS1.stop();
};

async function updateStates(always) {
    const tmap = new Set();
    let temp = [];
    A.D(`Will update states from XS1 (fetch lists, create/update states, cleanup)`);
    A.clearStates();
    try {
        temp = await myXS1.sendXS1("get_list_actuators");
        A.D(`Fetched actuators: ${Array.isArray(temp) ? temp.length : "n/a"}`);
        // Small pause to reduce load on XS1
        await A.wait(100);
        const sensors = await myXS1.sendXS1("get_list_sensors");
        A.D(`Fetched sensors: ${Array.isArray(sensors) ? sensors.length : "n/a"}`);
        temp = temp.concat(sensors);
        A.D(`Total items to process: ${Array.isArray(temp) ? temp.length : "n/a"}`);

        for (const o of temp) {
            tmap.add(o.lname);
            myXS1.names.set(o.name, o);
            const t = o.type;
            const c = {
                id: o.lname,
                name: o.lname,
                type: 'number',
                unit: o.unit,
                read: true,
                write: true,
                role: 'switch',
                native: {
                    //                    desc: JSON.stringify(o),
                    isSensor: (o.state !== undefined),
                    xs1Id: o.id
                }
            };
            if (c.native.isSensor)
                c.write = false;
            let r = myXS1.getRole(t);
            if (!r) {
                A.D("Undefined type " + t + ' for ' + c.name + ", using 'value' as role");
                r = "value";
            }
            c.role = r;
            c.type = myXS1.getType(t);
            if (c.type === 'boolean') {
                o.val = (o.value === undefined || o.value === false || o.value === 0) ? false : !!o.value;
                c.unit = "";
            }
            if (o.val === undefined)
                o.val = o.value;
            c.native.init = o;
            //            A.If('Start makeState with %O = %s', c, o.val);
            A.D(`Will makeState I ${A.O(c)}`);
            if (A.debug && o && o.name === 'Testschalter_3') {
                A.I(`[TRACE] Creating Testschalter_3 -> id=${c.id} type=${c.type} role=${c.role} val=${A.O(o.val)}`);
            }
            await A.makeState(c, o.val, true, always);
            if (o.state && Array.isArray(o.state) && o.state.length > 0) {
                //                A.D(`Item has a state: '${o.state[0]}'`);
                let val = false;
                const n = o.lname + '.LOWBAT';
                tmap.add(n);
                myXS1.names.set(o.name + '.LOWBAT', o);
                const c = {
                    id: n,
                    name: n,
                    type: 'boolean',
                    unit: undefined,
                    read: true,
                    write: false,
                    role: 'indicator.battery',
                    native: {
                        //                                desc: JSON.stringify(o),
                        isSensor: true,
                        xs1Id: o.id,
                        //                                src: o
                    }
                };
                for (let st of o.state)
                    val = val || (/low/i).test(st);
                A.D(`Will makeState II ${A.O(c)}`);
                await A.makeState(c, val, true, always);
            }
        }
        A.cleanup();
    } catch (err) {
        A.I(`Update Error: ${A.O(err)}`);
    }

}


async function main() {

    //    A.debug = true;

    // The adapters config (in the instance object everything under the attribute "native") is accessible via
    // adapter.config:
    if (A.C.adresse.endsWith('!')) {
        A.C.adresse = A.C.adresse.slice(0, -1).trim();
        A.debug = true;
    }
    A.I('config XS1 Addresse: ' + A.C.adresse);
    myXS1.resetXS1();

    copylist = A.J(A.C.copylist);
    //    A.I(`CopyList = ${A.O(copylist)}`);
    if (!copylist || copylist.error)
        copylist = {};
    // my personal one is
    // '{"UWPumpeT2":"UWPumpe","UWPumpe":"UWPumpeT2","UWLicht":"UWLichtT3","UWLichtT3":"UWLicht","GartenLichtT1":"GartenLicht","GartenLicht":"GartenLichtT1"}'
    A.I(`CopyList = ${A.O(copylist)}`);

    myXS1.on("error", msg => A.W('Error message from XS1:' + A.O(msg)));

    myXS1.on('data', async msg => {
            //        A.I("Data received "+A.O(msg) );
            if (msg && msg.lname) {
                const n = msg.lname + "." + msg.name;
                msg.ack = true;
                msg.q = 0;
                if (msg.name == 'Watchdog')
                    myXS1.update();
                //            A.I(`XS1 set ${n} to ${msg.val}`);
                //            adapter.setState(n,msg);
                A.D(`pSetState: ${n} = ${msg.hasOwnProperty('val') ? msg.val : msg}`);
                A.setState(n, msg.val, true);
                const o = myXS1.names.get(msg.name);
                if (o) {
                    o.oldValue = o.value;
                    o.newValue = o.value = msg.val;
                    let cl = copylist[msg.name];
                    if (cl) try {
                        cl = cl.split(',').map(x => x.trim());
                        for (const cn of cl) {
                            let co = myXS1.names.get(cn).value;
                            if (typeof o.newValue === 'boolean' && typeof co === 'number')
                                co = co != 0;
                            A.I(cn + " old " + co + " is new " + o.newValue);
                            if (co != o.newValue)
                                await myXS1.setState(cn, o.newValue);
                        }
                    } catch (err) {
                        A.I(`CopyList Err=${A.O(err)}`)
                    };
                }
            }
        }

    );
    try {
        await myXS1.startXS1(A.C.adresse);
        await updateStates(true); // Set states on first run
        A.I(`Finished state creation. Added totally ${myXS1.names.size} actuators or sensors`);
        myXS1.start(wToggle => myXS1.setState("Watchdog", wToggle));
        A.timer = setInterval(updateStates, 6 * 60 * 60 * 1000); // update states every 6 hours TODO
    } catch (err) {
        A.W(`Error in initialization: ${A.O(err)}, will stop adapter`);
        A.stop();
    }

}