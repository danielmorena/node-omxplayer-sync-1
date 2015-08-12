var omx = require('omxdirector')
  , osc = require('osc')
  , dbus = require('dbus-native')
  , fs = require('fs')
  , merge = require('merge')
  , EventEmitter = require('events').EventEmitter
  , uuid = require('node-uuid')
  , FPS = 25
  , TOLERANCE = 1 / FPS
  , FINE_TUNE_TOLERANCE = 10 * TOLERANCE
  , PORT = 5000
  , filename = '/home/pi/test.mp4'
;

////////////////////////////////////////////////////////////////////////////////
// Synchronization

function Clock() {
  this.offset = 0;
  this.isSynchronized = false;
}

Object.defineProperties( Clock.prototype, {
  "now": { value: function() { return Date.now() + this.offset; } },
  "sync": { value: function( then ) {
    this.offset = Date.now() - then;
    this.isSynchronized = true;
  } }
} );

var clock = new Clock();

////////////////////////////////////////////////////////////////////////////////
// OSC Initialization
var oscRouter = new EventEmitter();
var oscPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: PORT,
  remoteAddress: '192.168.1.255',
  remotePort: PORT,
  broadcast: true
});
oscPort.on( "bundle", handleBundle );
oscPort.on( "message", handleMessage );
oscPort.on( "ready", function() { console.log( "OSC sending and receiving on port " + PORT ); } );
oscPort.open();


function handleMessage ( message ) {
  oscRouter.emit( message.address, message.args );
};

function handleBundle ( bundle ) {
  var delta = clock.now() - bundle.timeTag.native;

  if ( delta <= 0 ) {
    bundle.packets.forEach( handlePacket );
  } else {
    setTimeout( function() { handleBundle( bundle ); }, delta );
  }
};

function handlePacket (packet) {
  packet.address ?  handleMessage( packet ) : handleBundle( packet );
};

////////////////////////////////////////////////////////////////////////////////
// DBus omxplayer control
function Bus() {
}

Bus.prototype = new EventEmitter();

Object.defineProperties( Bus.prototype, {
  invoke: { value: function() {
    this.dbus.invoke.apply( this.dbus, arguments );
  } },

  create: { value: function( tries ) {
    tries = tries === undefined ? 3 : tries;
    tries--;

    try {
      this.dbus = dbus.sessionBus({
        busAddress: fs.readFileSync('/tmp/omxplayerdbus.'+process.env.USER, 'ascii').trim()
      });
    } catch ( e ) {
      if ( e.code === "ENOENT" && tries >= 0 ) {
        console.log( "Could not connect to dbus, trying again." );
        setTimeout( function() { this.create( tries ) }.bind( this ), 500 );
        return;
      } else {
        console.log( "Failed to connect to dbus." );
        throw e;
      }
    }

    this.emit( "ready", this.dbus );

  } }
} );

var bus = new Bus();

var INTERFACE_SHORT_TO_FULL = {
  properties: 'org.freedesktop.DBus.Properties',
  player: 'org.mpris.MediaPlayer2.Player'
};

function PlayerController( bus, clock ) {
  this.bus = bus;
  this.sync = { seconds: -1, time: -1, invalid: true };
  this.speed = 0;
  this.clock = clock;
  this.waiting = false;
}

PlayerController.prototype = new EventEmitter();

Object.defineProperties( PlayerController.prototype, {
  invokeOMXDbus: { value: function( interfaceShort, options, cb ) {
    var interface = INTERFACE_SHORT_TO_FULL[ interfaceShort ] || interfaceShort;
    this.bus.invoke( merge( {
      path: '/org/mpris/MediaPlayer2',
      destination: 'org.mpris.MediaPlayer2.omxplayer',
      interface: interface
    }, options ), cb )
  } },


  getDuration: { value: function( cb ) {
    this.invokeOMXDbus( 'properties', { member: 'Duration' }, cb );
  } },

  getPosition: { value: function( cb ) {
    this.invokeOMXDbus( 'properties', { member: 'Position' }, cb );
  } },

  pause: { value: function( cb ) {
    this.invokeOMXDbus( 'player', { member: 'Pause' }, cb );
  } },

  play: { value: function( cb ) {
    this.invokeOMXDbus( 'player', { member: 'Play' }, cb );
  } },

  setPosition: { value: function( seconds ) {
    this.invokeOMXDbus( 'player', {
      member: 'SetPosition',
      signature: 'ox',
      body: [ '/not/used', seconds * 1e6 ]
    }, function( err, usPosition ) { // usPosition is just your arg, not the real new position
      if ( err ) console.log( "Error setting position:", err );
    } );
  } },

  // wrapping with duration is a workaround for position sometimes returning
  // weird values
  pollStatus: { value: function() {
    this.getDuration( function( err, usDuration ) {
      if ( err ) {
        setTimeout( this.pollStatus.bind( this ), 500 );
        return;
      }

      setInterval( function() {
        var time = this.clock.now();

        this.getPosition( function( err, usPosition ) {
          if ( usPosition > usDuration ) return;

          this.sync.seconds = usPosition / 1e6;
          this.sync.time = time;
          this.sync.invalid = false;

          this.emit( "status", this.sync );
        }.bind( this ) );
      // don't try to hammer it at more than 2FPS or it's more error prone
      }.bind( this ), 1e3 / FPS * 2 );
    }.bind( this ) );
  } },

  faster: { value: function() {
    this.speed++;
    omx.faster();
  } },

  slower: { value: function() {
    this.speed--;
    omx.slower();
  } },

  isReadyForSync: { value: function() {
    return ! this.sync.invalid && this.sync.seconds >= 0;
  } },

  invalid: {
    get: function() { return this.sync.invalid; },
    set: function( v ) { this.sync.invalid = v; }
  },

  seconds: {
    get: function() { return this.sync.seconds; }
  },

  time: {
    get: function() { return this.sync.time; }
  },

  synchronize: { value: function( seconds, time ) {
    if ( this.waiting || ! this.isReadyForSync() || seconds < 0 ) return;

    if ( ! this.clock.isSynchronized ) console.log( "synchronizing clock to master time" );
    this.clock.sync( time ); // doesn't compensate for latency...

    var now             = this.clock.now()
      , masterPosition  = seconds + ( now - time ) / 1e3
      , localPosition   = this.seconds + ( now - this.time ) / 1e3
      , delta           = localPosition - masterPosition
      , absDelta        = Math.abs( delta );

    if ( absDelta > TOLERANCE ) {
      this.invalid = true;

      if ( absDelta < FINE_TUNE_TOLERANCE ) {
        console.log( "sync fine-tune", delta );

        if ( delta > 0 && this.speed >= 0 ) this.slower();
        else if ( this.speed <= 0 ) this.faster();

      } else {
        console.log( "sync jump", delta );

        if ( delta > 0 ) {
          this.waiting = true;
          this.pause( function( err ) {
            if ( !err ) {
              var waitFor = delta * 1e3 - ( this.clock.now() - now );
              setTimeout( function() {
                this.play( function(){} );
                this.waiting = false;
              }.bind( this ), waitFor );
            } else this.waiting = true;
          }.bind( this ) );

        } else {
          this.setPosition( masterPosition );
        }
      }

    } else {
      this.reset();
    }
  } },

  reset: { value: function() {
    this.play();
    while( this.speed < 0 ) this.faster();
    while( this.speed > 0 ) this.slower();
  } }

} );

var controller = new PlayerController( bus, clock );

bus.on( "ready", function( dbus ) {
  controller.pollStatus();
} );

////////////////////////////////////////////////////////////////////////////////
// Node

var NODE_STATE = { master: 0, slave: 1, indeterminate: 2 };

function Node( options ) {
  this.heartbeatTimeout = options.heartbeatTimeout || 1000;
  this.electTimeout = options.electTimeout || 100;
  this.votingTimeout = options.votingTimeout || 750;
  this.state = NODE_STATE.indeterminate;
  this.id = uuid.v4();
  this.on( "heartbeat lost", this.elect.bind( this ) );
}

Node.prototype = new EventEmitter();

Object.defineProperties( Node.prototype, {
  elect: { value: function( cycle ) {
    cycle = cycle === undefined ? 0 : cycle;
    if ( cycle === 0 ) this.votes = 0;
    this.state = NODE_STATE.indeterminate;

    this.emit( "elect", this.id );
    this.__electTimeout = setTimeout( function() {
      this.elect( cycle + 1 );
    }.bind( this ), this.electTimeout );
  } },

  stopElection: { value: function() {
    clearTimeout( this.__electTimeout );
    clearTimeout( this.__waitForVotesTimeout );
  } },

  heartbeat: { value: function() {
    if ( this.__heartbeatTimeout ) clearTimeout( this.__heartbeatTimeout );

    this.__heartbeatTimeout = setTimeout( function(){
      this.emit( "heartbeat lost" )
    }.bind( this ), this.heartbeatTimeout );

    this.emit( "heartbeat" );
  } },

  votes: {
    get: function() { return this._votes; },
    set: function( v ) {
      this._votes = v;
      if ( this.__votingTimeout ) clearTimeout( this.__votingTimeout );
      this.__votingTimeout = setTimeout( function() {
        this.isMaster = true;
      }.bind( this ), this.votingTimeout );
    }
  },

  isMaster: {
    get: function() { return this.state === NODE_STATE.master; },
    set: function( v ) {
      this.state = v ? NODE_STATE.master : NODE_STATE.indeterminate;
      this.stopElection();
      this.emit( "master" );
    }
  },

  isSlave: {
    get: function() { return this.state === NODE_STATE.slave; },
    set: function( v ) {
      this.state = v ? NODE_STATE.slave : NODE_STATE.indeterminate;
      this.stopElection();
      this.emit( "slave" );
    }
  }
} );

var node = new Node( { heartbeatTimeout: 1000 } );
node.heartbeat();

////////////////////////////////////////////////////////////////////////////////
// Node Transport

node.on( "master", function() {
  controller.reset();
  console.log( "imma master!" );
} );
node.on( "slave", function() { console.log( "imma slave!" ); } );

node.on( "elect", function( id ) {
  console.log( "send elect " + id );
  oscPort.send( {
    address: "/elect",
    args: [ { type: 's', value: id } ]
  } );
} );

controller.on( "status", function( status ) {
  if ( ! node.isMaster ) return;

  var elapsed = status.seconds
    , time = osc.timeTag( 0, status.time );

  oscPort.send( {
    address: "/sync",
    args: [ { type: 'f', value: elapsed }, { type: 't', value: time } ]
  } );
} );

bus.on( "ready", function() {
  oscRouter.on( "/sync", function( args ) {
    node.heartbeat();
    controller.synchronize( args[ 0 ], args[ 1 ].native );
  } );

  oscRouter.on( "/elect", function( args ) {
    var otherId = args[ 0 ];
    if ( node.id > otherId ) {
      console.log( "got elect " + otherId + ", incrementing votes" );
      node.votes++;
    } else if ( node.id < otherId ) {
      console.log( "got elect " + otherId + ", becoming slave" );
      node.isSlave = true;
    } // else my own id
  } );
} );

////////////////////////////////////////////////////////////////////////////////
// OMXDirector setup
omx.enableNativeLoop();

process.on("SIGINT", function() {
  console.log("Quitting");
  omx.stop();
});

omx.on('stop', function(){
  console.log("Done.");
  process.exit();
});

//omx.on('status', function(status){ localSecs = status.seconds; } );


var args = [];
//args.push("--blank");
//args = args.concat(["--win", "0,0,960,540"]);
omx.play( filename, {loop: true, args: args} );

bus.create();
