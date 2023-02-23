const {SerialPort} = require("serialport");
const SerialPortParser = require("@serialport/parser-readline");
const GPS = require("gps");
const mqtt = require('mqtt');
const {nanoid} = require("nanoid");
const moment = require('moment');

const mavlink = require('./mavlink.js');

const gpi_frequency = 2;

let boot_time = null;
let boot_start_time = moment().valueOf();

let gpsPort = null;
let gpsPortNum = 'COM6';
let gpsBaudrate = '9600';

gpsPortOpening();

let gps = null;
let parser = null;

let globalpositionint_msg = '';
const my_system_id = 254;

let local_mqtt_client = null;
let pub_gps_tracker_location_topic = '/GPS/location';

let t_count = 0;

local_mqtt_connect('127.0.0.1');

let mavData = {};
// mavData.fix_type = 0;
mavData.lat = 0;
mavData.lon = 0;
mavData.alt = 0;
mavData.relative_alt = 0;
// mavData.eph = 0;
// mavData.epv = 0;
// mavData.vel = 0;
// mavData.cog = 0;
// mavData.satellites_visible = 0;
mavData.vx = 0;
mavData.hdg = 0;

function gpsPortOpening() {
    if (gpsPort == null) {
        gpsPort = new SerialPort({
            path: gpsPortNum,
            baudRate: parseInt(gpsBaudrate, 10),
        });

        gpsPort.on('open', gpsPortOpen);
        gpsPort.on('close', gpsPortClose);
        gpsPort.on('error', gpsPortError);
        gpsPort.on('data', gpsPortData);
    } else {
        if (gpsPort.isOpen) {
            gpsPort.close();
            gpsPort = null;
            setTimeout(gpsPortOpening, 2000);
        } else {
            gpsPort.open();
        }
    }
}

function gpsPortOpen() {
    console.log('gpsPort open. ' + gpsPort.path + ' Data rate: ' + gpsPort.baudRate);

    gps = new GPS();
    parser = gpsPort.pipe(new SerialPortParser());
}

function gpsPortClose() {
    console.log('gpsPort closed.');

    setTimeout(gpsPortOpening, 2000);
}

function gpsPortError(error) {
    console.log('[gpsPort error]: ' + error.message);

    setTimeout(gpsPortOpening, 2000);
}

function gpsPortData() {
    gps.on("data", data => {
        t_count = 0;
        // console.log("gps data === ", data);
        if (data.type === 'GGA') {
            if (data.quality != null) {
                mavData.lat = data.lat;
                mavData.lon = data.lon;
                mavData.alt = data.alt;
                // mavData.satellites_visible = data.satellites;
                // mavData.eph = data.hdop;
                // if (data.quality === 2) {
                //     mavData.fix_type = 4;
                // }
            } else {
                mavData.lat = 0;
                mavData.lon = 0;
                mavData.alt = 0;
                mavData.relative_alt = 0;
                // mavData.eph = 0;
                // mavData.satellites_visible = 0;
                // mavData.fix_type = 1
            }
            // setTimeout(createMAVLinkData, 1, my_system_id, boot_time, mavData);
        } else if (data.type === 'GSA') {
            // if (mavData.fix_type !== 4) {
            //     if (data.fix === '3D') {
            //         mavData.fix_type = 3;
            //     } else if (data.fix === '2D') {
            //         mavData.fix_type = 2;
            //     } else {
            //         mavData.fix_type = 1;
            //     }
            // }
            // mavData.eph = data.hdop;
            // mavData.epv = data.vdop;
            // setTimeout(createMAVLinkData, 1, my_system_id, boot_time, mavData);
        } else if (data.type === 'RMC') {
            mavData.vx = data.speed / 1.944;
            // mavData.vel = data.speed / 1.944;
            // mavData.cog = data.track;
            // console.log(data);
            // setTimeout(createMAVLinkData, 1, my_system_id, boot_time, mavData);
        } else if (data.type === 'VTG') {
            mavData.vx = data.speed / 1.944;
            // mavData.vel = data.speed / 1.944;
            mavData.hdg = data.track;
            // console.log(data);
        }
    });
}

parser.on("data", data => {
    // console.log('parser', data)
    gps.update(data);
});

function local_mqtt_connect(broker_ip) {
    if (local_mqtt_client == null) {
        var connectOptions = {
            host: broker_ip,
            port: 1883,
            protocol: "mqtt",
            keepalive: 10,
            clientId: 'Tracker_GPS_' + nanoid(15),
            protocolId: "GPS_",
            protocolVersion: 4,
            clean: true,
            reconnectPeriod: 2000,
            connectTimeout: 2000,
            rejectUnauthorized: false
        };


        local_mqtt_client = mqtt.connect(connectOptions);

        local_mqtt_client.on('connect', function () {
            console.log('[local_mqtt] connected to ' + broker_ip);
        });

        local_mqtt_client.on('error', function (err) {
            console.log('[local_mqtt] error: ' + err.message);
            local_mqtt_client = null;
            local_mqtt_connect(broker_ip);
        });
    }
}

setInterval(() => {
    t_count++;
    if (t_count > (30 * gpi_frequency)) {
        console.log("Couldn't receive messages.")
    } else {
        setTimeout(createMAVLinkData, 1, my_system_id, boot_time, mavData);
    }
}, (1000 / gpi_frequency));

setInterval(function () {
    boot_time = moment().valueOf() - boot_start_time;
}, 1);

function createMAVLinkData(sys_id, boot_time, mavdata) {
    // #33, GLOBAL_POSITION_INT
    let params = {};
    params.target_system = sys_id;
    params.target_component = 1;
    params.time_boot_ms = boot_time;
    params.lat = parseFloat(mavdata.lat) * 1E7;
    params.lon = parseFloat(mavdata.lon) * 1E7;
    params.alt = parseFloat(mavdata.alt) * 1000;
    params.relative_alt = 0;  // TODO: 추후 트래커 높이(고정값, 삼각대 높이)로 수정
    params.vx = mavdata.vx;
    params.vy = 0;
    params.vz = 0;
    params.hdg = mavdata.hdg;

    try {
        globalpositionint_msg = mavlinkGenerateMessage(params.target_system, params.target_component, mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, params);
        if (globalpositionint_msg === null) {
            console.log("mavlink message(MAVLINK_MSG_ID_GLOBAL_POSITION_INT) is null");
        } else {
            local_mqtt_client.publish(pub_gps_tracker_location_topic, Buffer.from(globalpositionint_msg, 'hex'));
        }
    } catch (ex) {
        console.log('[ERROR (GLOBAL_POSITION_INT)] ' + ex);
    }
}

function mavlinkGenerateMessage(src_sys_id, src_comp_id, type, params) {
    const mavlinkParser = new MAVLink(null/*logger*/, src_sys_id, src_comp_id);
    try {
        var mavMsg = null;
        var genMsg = null;

        switch (type) {
            case mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT:
                mavMsg = new mavlink.messages.global_position_int(params.time_boot_ms,
                    params.lat,
                    params.lon,
                    params.alt,
                    params.relative_alt,
                    params.vx,
                    params.vy,
                    params.vz,
                    params.hdg
                );
                break;
        }
    } catch (e) {
        console.log('MAVLINK EX:' + e);
    }

    if (mavMsg) {
        genMsg = Buffer.from(mavMsg.pack(mavlinkParser));
    }

    return genMsg;
}
