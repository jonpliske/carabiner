path = require 'path'
fs = require 'fs'

async  = require 'async'
splunkjs = require 'splunk-sdk'
Table = require 'cli-table'

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

options = defaults()

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
  console.log '#      ' + eventSearch
  console.log '#'
  console.log '###'
  console.log '\n'

  cb noErr, job

fetchJob = (job, cb) ->
  job.fetch cb

performSearch = (searchString) ->
  (loggedIn, cb) ->
    throw new Error 'login failed' unless loggedIn

    splunk.search searchString, exec_mode: 'blocking', cb

fetchResults = (job, cb) ->
  job.results {}, cb

splunk = new splunkjs.Service
  scheme:     options.scheme
  host:       options.host
  port:       options.port
  username:   options.username
  password:   options.password
  version:    options.version

searchString = """
search index=summary search_name=sub_flow_itier_boomerang_t_done_by_browser
  earliest=-5m@m
  latest=now
| stats avg(*_perc50) as *
"""

async.waterfall [

  splunk.login
  performSearch searchString
  fetchJob
  searchStats
  fetchResults

], (err, results) ->
  if err?
    console.log err
    throw err

  if process.env.TABLE
    {fields, rows} = results
    table = new Table head: fields
    table.push row for row in rows
    console.log table.toString()
  else
    console.log results

noErr = null