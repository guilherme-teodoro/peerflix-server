'use strict';

var stats = require('./stats');

module.exports = function (server) {
    var WebSocket = require('ws'),
        _ = require('lodash'),
        progress = require('./progressbar'),
        transit = require('transit-js'),
        store = require('./store');

    var tWriter = transit.writer("json");

    var sockets = new WebSocket.Server({server: server});

    var encode = function (data) {
        return tWriter.write(data);
    };

    sockets.on('connection', function (socket) {
        socket.on('pause', function (infoHash) {
            console.log('pausing ' + infoHash);
            var torrent = store.get(infoHash);
            if (torrent && torrent.swarm) {
                torrent.swarm.pause();
            }
        });
        socket.on('resume', function (infoHash) {
            console.log('resuming ' + infoHash);
            var torrent = store.get(infoHash);
            if (torrent && torrent.swarm) {
                torrent.swarm.resume();
            }
        });
        socket.on('select', function (infoHash, file) {
            console.log('selected ' + infoHash + '/' + file);
            var torrent = store.get(infoHash);
            if (torrent && torrent.files) {
                file = torrent.files[file];
                file.select();
            }
        });
        socket.on('deselect', function (infoHash, file) {
            console.log('deselected ' + infoHash + '/' + file);
            var torrent = store.get(infoHash);
            if (torrent && torrent.files) {
                file = torrent.files[file];
                file.deselect();
            }
        });

        store.on('torrent', function (infoHash, torrent) {
            function listen() {
                var notifyProgress = _.throttle(function () {
                    socket.send(encode({type: 'download',
                                        hash: infoHash,
                                        progress: progress(torrent.bitfield.buffer)}));
                }, 1000, { trailing: false });

                var notifySelection = _.throttle(function () {
                    var pieceLength = torrent.torrent.pieceLength;
                    socket.send(encode({type: 'selection',
                                        hash:infoHash,
                                        teste: torrent.files.map(function (f) {
                                            // jshint -W016
                                            var start = f.offset / pieceLength | 0;
                                            var end = (f.offset + f.length - 1) / pieceLength | 0;
                                            return torrent.selection.some(function (s) {
                                                return s.from <= start && s.to >= end;
                                            });
                                        })}));
                }, 2000, { trailing: false });

                socket.send(encode({type: 'verifying', hash: infoHash, stats: stats(torrent)}));

                torrent.once('ready', function () {
                    socket.send(encode({type: 'ready', hash: infoHash, stats: stats(torrent)}));
                });

                torrent.on('uninterested', function () {
                    socket.send(encode({type: 'uninterested', hash: infoHash}));
                    notifySelection();
                });

                torrent.on('interested', function () {
                    socket.send(encode({type: 'interested', hash: infoHash}));
                    notifySelection();
                });

                var interval = setInterval(function () {
                    socket.send(encode({type: 'stats', hash: infoHash, stats: stats(torrent)}));
                    notifySelection();
                }, 1000);

                torrent.on('verify', notifyProgress);

                torrent.on('finished', function () {
                    socket.send(encode({type: 'finished', hash: infoHash}));
                    notifySelection();
                    notifyProgress();
                });

                torrent.once('destroyed', function () {
                    clearInterval(interval);
                    socket.send(encode({type: 'destroyed', hash: infoHash}));
                });
            }

            if (torrent.torrent) {
                listen();
            } else {
                torrent.once('verifying', listen);
            }
        });

    });
};
