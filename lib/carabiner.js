module.exports = exports = carabiner;

var fs = require('fs'),
    path = require('path'),
    util = require('util'),
    nopt = require('nopt'),
    async = require('async'),
    splunkjs = require('splunk-sdk'),
    Table = require('cli-table'),
    sparkline = require('sparkline'),
    knownOpts = {
      "table" : Boolean,
      "earliest": String,
      "latest": String,
      "limit": Number,
      "stats": Boolean,
      "query": String,
      "debug": Boolean,
      "help": Boolean,
      "json": Boolean,
      "silent": Boolean,
      "timeline": Boolean
    },
    shortHands = {
      't' : ["--table"],
      's' : ["--stats"],
      'h' : ['--help']
    },
    noErr = null,
    debug = null,
    log = null;

function zip (fields, rows) {
  var zippedResults = [],
      zippedObject,
      currentRow;

  for (var i = rows.length - 1; i >= 0; i--) {
    currentRow = rows[i];
    zippedObject = {};

    for (var x = currentRow.length - 1; x >= 0; x--) {
      zippedObject[fields[x]] = currentRow[x];
    };

    zippedResults.push(zippedObject);
  };

  return zippedResults.reverse();
}

function carabiner() {
  var parsed = nopt(knownOpts, shortHands),
      splunk = new splunkjs.Service(config(parsed));

  if (parsed.argv.original.length === 0 || parsed.help) {
    return usage();
  }

  if (parsed.silent || parsed.json) {
    log = function() {};
  } else {
    log = function() {
      var args = [];
      args.push('[INFO]');
      args.push.apply(args, Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    };
  }

  if (parsed.debug) {
    debug = function() {
      var args = [];
      args.push('[DEBUG]');
      args.push.apply(args, Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    };
  } else {
    debug = function() {};
  }

  async.waterfall([

    splunk.login,
    performSearch(parsed),
    fetchJob,
    hookSignals,
    monitorSearch,
    searchStats,
    fetchTimeline,
    fetchResults

  ], function(err, results) {
    if (err) {
      log(err);
      throw err;
    }

    if (parsed.table && !parsed.json) {
      var fields = results.fields,
          rows = results.rows.reverse(),
          table = new Table({head: fields});

      for (var i = rows.length - 1; i >= 0; i--) {
        table.push(rows[i]);
      };

      console.log(table.toString());
    } else if (parsed.json) {
      console.log(JSON.stringify(zip(results.fields, results.rows)));
    } else {
      console.log(results);
    }
  })

  function fetchResults (job, cb) {
    debug('fetchResults()');
    job.results({}, cb);
  }

  function fetchJob (job, cb) {
    debug('fetchJob()');
    job.fetch(cb);
  }

  function hookSignals (job, cb) {
    debug('hookSignals()');
    process.on('SIGINT', function() {
      log('Recieved SIGINT: cancelling job');

      job.cancel(function(err) {
        if (err)
          cb(err);

        log('-- search canceled --');
        process.exit();
      });
    });

    cb(noErr, job);
  }

  function monitorSearch (job, cb) {
    debug('monitorSearch()');
    var count = 0,
        conf = config(),
        jobUrl = conf.scheme + '://' + conf.host + ':' + conf.port + job.qualifiedPath;

    function roundWithPrecision (num, precision) {
      var multiplier = Math.pow(10, precision);
      return Math.round(num * multiplier) / multiplier
    }

    log("");
    log('-- search running: ' + jobUrl);

    async.until(
      function() { return job.properties().isDone; },
      function(done) {
        job.fetch(function(err) {
          if (err)
            done(err);

          var eventCount = job.properties().eventCount,
              doneProgress = job.properties().doneProgress;

          if (eventCount > count) {
            log("-- in progress, " + eventCount + " events, " + roundWithPrecision(doneProgress * 100.0, 2) + "% complete");
            count = eventCount;
          }

          done();
        });
      },
      function(err) {
        if (err)
          cb(err);

        log('-- search complete --');
        cb(noErr, job);
      }
    );

  }

  function performSearch (args) {
    debug('performSearch()');

    // TODO: remove sync calls
    function readQuery (queryPath) {
      if (!queryPath || !fs.existsSync(queryPath))
        return;

      var lines = fs.readFileSync(queryPath).toString().split('\n'),
          output = [],
          line = null;

      for (var i = 0; i < lines.length; ++i) {
        line = lines[i].trim();
        if (line !== '' && line[0] !== '#') {
          output.push(line);
        }
      }

      return output.join('\n');
    }

    return function (loggedIn, cb) {
      if (loggedIn != true) {
        log("not logged in");
        cb(new Error('login failed'));
      }

      var searchString = "search " + readQuery(args.argv.remain[0]),
          searchOptions = {
            status_buckets: 300,
            earliest_time: args.earliest,
            latest_time: args.latest
          };

      debug(searchString, searchOptions);

      return splunk.search(searchString, searchOptions, cb)
    }
  }

  function searchStats (job, cb) {
    if (!job)
      cb(new Error('no job'));

    if (!parsed.stats)
      return cb(noErr, job);

    var props = job.properties(),
        eventCount = props.eventCount,
        diskUsage = props.diskUsage,
        priority = props.priority,
        runDuration = props.runDuration,
        eventSearch = job.eventSearch;

    log('');
    log('### JOB statistics');
    log('#');
    log('#    duration: ' + runDuration + 's');
    log('#    eventCount: ' + eventCount);
    log('#    diskUsage: ' + diskUsage / 1024 + ' KB');
    log('#    priority: ' + priority);
    log('#');
    log('###');
    log('');

    return cb(noErr, job);
  }

  function fetchJob (job, cb) {
    return job.fetch(cb);
  }

  function fetchTimeline (job, cb) {
    if (!parsed.timeline)
      return cb(noErr, job);

    job.timeline({time_format: "%c"}, function(err, timeline, job) {
      if (err)
        cb(err);

      if (timeline)
        presentTimeline(timeline);

      cb(noErr, job);
    });
  }

  function presentTimeline (timeline) {
    if (!timeline.buckets || timeline.buckets.length < 1)
     return;

    function formatDuration(seconds) {
      if (seconds < 60) {
        return seconds + 's';
      } else if (seconds < 3600) {
        return (seconds / 60) + ' min';
      } else if (seconds < 86400) {
        return (seconds / 60 / 60) + 'h';
      } else {
        return (seconds / 60 / 60 / 24) + ' days';
      }
    }

    var buckets  = timeline.buckets,
        counts   = buckets.map(function(bucket) { return bucket.total_count }),
        min      = Math.min.apply(null, counts),
        max      = Math.max.apply(null, counts),
        pad      = function(width) { return new Array(width + 1).join(' ') },
        spark    = sparkline(counts),
        earliest = buckets[0].earliest_strftime,
        latest   = buckets[buckets.length - 1].earliest_strftime,
        duration = buckets[0].duration,
        minPad   = pad(min.toString().length + 1),
        maxPad   = minPad + pad(spark.length + 1);

    debug(buckets);
    debug(counts);
    console.log
      ( [ "\nTimeline:"
        , ""
        , earliest + " - " + latest + " (" + "1 bar = " + formatDuration(duration) + ")"
        , ""
        , maxPad + max
        , minPad + spark
        , min
        , ""
        ].join("\n"));
  }
}

function config() {
  var configPath = path.join(process.env.HOME, '.splunkrc');

  function readConfig (path) {
    var config, key, line, lines, parts, val;
    config = {};
    lines = fs.readFileSync(path, 'utf8').split('\n');
    for (var i = 0; i < lines.length; ++i) {
      line = lines[i].trim();
      if (line !== '' && line[0] !== '#') {
        parts = line.split('=');
        key = parts[0].trim();
        val = parts[1].trim();
        config[key] = val;
      }
    }
    return config;
  };

  if (fs.existsSync(configPath)) {
    return readConfig(configPath);
  } else {
    throw new Error('config file not found: ' + configPath);
  };
}

function usage() {
  console.log
    ( ["\nUsage: carabiner [opts] <queryFile>"
      , ""
      , "where <queryFile> is a file containing a splunk query"
      , "and [opts] can include:"
      , ""
      , "--table, -t     display results in a table"
      , "--earliest      specify the start time of the search"
      , "--latest        specify the end time of the search"
      , "--stats, -s     display stats upon completion of search"
      , "--debug         show debug/tracing information"
      , "--help, -h      display usage information"
      , "--json          display results json objects in array"
      , "--silent        suppress informational logging"
      , "--timeline      include timeline distribution with results"
      ].join("\n"));
}
