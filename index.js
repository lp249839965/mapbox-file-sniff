var zlib = require('zlib');
var isgeocsv = require('@mapbox/detect-geocsv');
var invalid = require('./lib/invalid');
var fs = require('fs');
var bf = require('buffer');
var semver = require('semver');

module.exports.fromBuffer = fromBuffer;
module.exports.fromFile = fromFile;

/**
 * Main sniffer.
 */
function fromBuffer(buffer, callback) {
    if (!callback || typeof callback !== 'function') throw new Error('Invalid callback. Must be a function.');

    if (!Buffer.isBuffer(buffer)) return callback(invalid('Input is not a valid buffer.'));

    detect(buffer, function(err, type) {
        if (err) return callback(err);
        var protocol = getProtocol(type);
        return callback(null, {type: type, protocol: protocol});
    });
};

function fromFile(file, callback) {
    if (!callback || typeof callback !== 'function') throw new Error('Invalid callback. Must be a function.');

    fs.open(file, 'r', function(err, fd) {
        if (err) return callback(err);
        fs.fstat(fd, function(err, stats) {
            if (err) return callback(err);
            if (stats.size === 0) return callback(invalid('File is zero bytes.'));
            var size = stats.size < 512 ? stats.size : 512;
            fs.read(fd, new Buffer(size), 0, size, 0, function(err, bytes, buffer) {
                if (bytes <= 2)
                    err = err || invalid('File too small');
                fs.close(fd, function(closeErr) {
                    if (err || closeErr) return callback(err || closeErr);
                    detect(buffer, function(err, type) {
                        if (err) return callback(err);
                        var protocol = getProtocol(type);
                        return callback(null, {type: type, protocol: protocol});
                    });
                });
            });
        });
    });
}

function detect(buffer, callback) {
    var header = buffer.toString().substring(0, 400);

    // check for topojson/geojson
    if (header.trim().indexOf('{') == 0) {

        // Remove spaces
        var str = JSON.stringify(header);
        var nospaces = str.replace(/\s/g, '');
        header = JSON.parse(nospaces);

        if (header.indexOf('\"tilejson\":') !== -1) return callback(null, 'tilejson');
        if ((header.indexOf('\"arcs\":') !== -1) || (header.indexOf('\"objects\":') !== -1)) return callback(null, 'topojson');
        if ((header.indexOf('\"features\":') !== -1) || (header.indexOf('\"geometries\":') !== -1) || (header.indexOf('\"coordinates\":') !== -1)) return callback(null, 'geojson');
        if (header.indexOf('\"type\":') !== -1) {
            var m = /"type":\s?"(.+?)"/.exec(header);
            if (!m) {
                return callback(invalid('Unknown filetype'));
            }
            if (m[1] === 'Topology') return callback(null, 'topojson');
            if (m[1] === 'Feature' ||
                m[1] === 'FeatureCollection' ||
                m[1] === 'Point' ||
                m[1] === 'MultiPoint' ||
                m[1] === 'LineString' ||
                m[1] === 'MultiLineString' ||
                m[1] === 'Polygon' ||
                m[1] === 'MultiPolygon' ||
                m[1] === 'GeometryCollection') return callback(null, 'geojson');
        }
        return callback(invalid('Unknown filetype'));
    }

    var head = header.substring(0, 100);
    if (head.indexOf('SQLite format 3') === 0) {
        return callback(null, 'mbtiles');
    }
    if ((head[0] + head[1]) === 'PK') {
        return callback(null, 'zip');
    }
    // check if geotiff/bigtiff
    // matches gdal validation logic: https://github.com/OSGeo/gdal/blob/trunk/gdal/frmts/gtiff/geotiff.cpp#L6892-L6893
    if ((head.slice(0, 2).toString() === 'II' || head.slice(0, 2).toString() === 'MM') && ((buffer[2] === 42) || buffer[3] === 42 || buffer[2] === 43)) {
        return callback(null, 'tif');
    }
    // take into account BOM char at index 0
    if (((head.indexOf('<?xml') === 1) || (head.indexOf('<?xml') === 0)) && (head.indexOf('<kml') !== -1)) {
        return callback(null, 'kml');
    }
    // take into account BOM char at index 0
    if (((head.indexOf('<?xml') === 1) || (head.indexOf('<?xml') === 0)) && (head.indexOf('<gpx') !== -1)) {
        return callback(null, 'gpx');
    }
    if (head.indexOf('<VRTDataset') !== -1) {
        return callback(null, 'vrt');
    }
    // check for unzipped .shp
    if (buffer.length > 32 && buffer.readUInt32BE(0) === 9994) {
        return callback(null, 'shp');
    }

    // Check for geocsv
    if (isgeocsv(buffer)) {
        return callback(null, 'csv');
    }

    function returnOutput(output,callback) {
        //check for tm2z
        if (output.toString('ascii', 257, 262) === 'ustar') return callback(null, 'tm2z');
        //check for serial tiles
        head = output.slice(0, 50);
        if (head.toString().indexOf('JSONBREAKFASTTIME') === 0) return callback(null, 'serialtiles');

        if (
            (output.slice(0, 2).toString() === 'II' || output.slice(0, 2).toString() === 'MM')
            && ((output[2] === 42) || output[3] === 42 || output[2] === 43)) {
            return callback(null, 'tif+gz');
        }

        //default to unknown
        return callback(invalid('Unknown filetype'));
    }

    var zlib_opts = {finishFlush: zlib.Z_SYNC_FLUSH };
    zlib.gunzip(buffer, zlib_opts, function(err, output) {
      if (err) return callback(invalid('Unknown filetype'));
      returnOutput(output, callback);
    });
}

function getProtocol(type) {
    var mapping = {
        csv: 'omnivore:',
        mbtiles: 'mbtiles:',
        shp: 'omnivore:',
        zip: 'omnivore:',
        tif: 'omnivore:',
        'tif+gz': 'omnivore:',
        vrt: 'omnivore:',
        geojson: 'omnivore:',
        topojson: 'omnivore:',
        kml: 'omnivore:',
        gpx: 'omnivore:',
        tilejson: 'tilejson:',
        tm2z: 'tm2z:',
        serialtiles: 'serialtiles:'
    };

    return mapping[type];
}
