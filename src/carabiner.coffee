path = require 'path'
fs = require 'fs'
util = require 'util'

async  = require 'async'
splunkjs = require 'splunk-sdk'
Table = require 'cli-table'

module.exports = ->

  processArgs = (argv) ->
    args = argv.slice(2)
    options = {}

    options.table = '--table' in args

    potentialFilename = args.slice(-1)[0]
    if potentialFilename and fs.existsSync potentialFilename
      options.query = fs.readFileSync(potentialFilename).toString()

    options

  readDefaults = (path) ->
    defaults = {}
    lines = fs.readFileSync(path, 'utf8').split("\n")

    for line in lines
      line = line.trim()

      if line != "" and line[0] != '#'
        parts = line.split '='
        key = parts[0].trim()
        val = parts[1].trim()

        defaults[key] = val

    defaults

  # grabs defaults from ~/.splunkrc
  defaults = ->
    defaultsPath = path.join process.env.HOME, '.splunkrc'
    if fs.existsSync defaultsPath
      readDefaults defaultsPath
    else
      throw new Error 'no defaults'

  omit = (obj) ->
    copy = {}
    keys = Array::concat.apply Array.prototype, Array::slice.call(arguments, 1)
    for key, val of obj
      copy[key] = val unless key in keys
    copy

  args = processArgs process.argv
  options = defaults()
  options.table = args.table
  options.query = args.query

  ## ---
  # search steps

  searchStats = (job, cb) ->
    cb new Error 'no job' unless job?

    {eventCount, diskUsage, priority, runDuration, eventSearch} = job.properties()

    # console.log job.properties()

    console.log '\n'
    console.log '### JOB statistics'
    console.log '#'
    console.log '#    duration: ' + runDuration + 's'
    console.log '#    eventCount: ' + eventCount
    console.log '#    diskUsage: ' + diskUsage / 1024 + ' KB'
    console.log '#    priority: ' + priority
    console.log '#'
    console.log '#    search:'
    console.log '#      ' + options.query
    console.log '#'
    # console.log '#    options:'
    # console.log '#      ' + util.inspect omit options, 'password'
    # console.log '#'
    console.log '###'
    console.log '\n'

    cb noErr, job

  fetchJob = (job, cb) ->
    job.fetch cb

  hookSignals = (job, cb) ->
    process.on 'SIGINT', ->
      console.log 'Recieved SIGINT: cancelling job'
      job.cancel (err) ->
        cb err if err?
        console.log '-- search canceled --'
        process.exit()

    cb noErr, job

  performSearch = (searchString) ->
    (loggedIn, cb) ->
      throw new Error 'login failed' unless loggedIn

      splunk.search searchString, {}, cb

  monitorSearch = (job, cb) ->
    count = 0
    jobUrl = options.scheme + '://' + options.host + ':' + options.port + job.qualifiedPath

    console.log ''
    console.log "-- search running: " + jobUrl

    async.until (-> job.properties().isDone), ((done) ->
      job.fetch (err) ->
        done err if err?
        newCount = job.properties().eventCount
        if newCount > count
          console.log "-- in progress, #{count} events"
          count = newCount
        done()
    ), (err) ->
      cb err if err?
      console.log '-- search complete --'
      cb noErr, job

  fetchResults = (job, cb) ->
    job.results {}, cb

  splunk = new splunkjs.Service
    scheme:     options.scheme
    host:       options.host
    port:       options.port
    username:   options.username
    password:   options.password
    version:    options.version

  async.waterfall [

    splunk.login
    performSearch options.query
    fetchJob
    hookSignals
    monitorSearch
    searchStats
    fetchResults

  ], (err, results) ->
    if err?
      console.log err
      throw err

    if options.table
      {fields, rows} = results
      table = new Table head: fields
      table.push row for row in rows
      console.log table.toString()
    else
      console.log results

  noErr = null