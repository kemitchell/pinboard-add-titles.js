#!/usr/bin/env node
const Multistream = require('multistream')
const cheerio = require('cheerio')
const flushWriteStream = require('flush-write-stream')
const http = require('http-https')
const jsonArrayStreams = require('json-array-streams')
const once = require('once')
const pump = require('pump')
const querystring = require('querystring')
const through2 = require('through2')

// Read the Pinboard authentication token from the environment.
const TOKEN = process.env.PINBOARD_TOKEN
if (!TOKEN) {
  process.stdout.write('Missing PINBOARD_TOKEN')
  process.exit(1)
}

const argument = parseInt(process.argv[2])
const LIMIT = Number.isInteger(argument) && argument > 0 ? argument : Infinity
const DELAY = 3000

const PINBOARD_API = 'api.pinboard.in'

const RESULTS_PER_REQUEST = 100
let requestCount = 0
// In order to tell when to stop issuing new requests with incremented
// `start` positions, count the number of posts from each response.
let postsFromLastStream = null
let totalPosts = 0

// Request all of the Pinboard user's posts in JSON format.
pump(
  new Multistream(callback => {
    if (postsFromLastStream === 0) return callback(null, null)
    http.request({
      protocol: 'https:',
      host: PINBOARD_API,
      path: '/v1/posts/all?' + querystring.stringify({
        auth_token: TOKEN,
        results: RESULTS_PER_REQUEST,
        start: requestCount * RESULTS_PER_REQUEST,
        format: 'json'
      })
    })
      .once('error', callback)
      .once('response', response => {
        requestCount++
        // Reset the posts counter when this stream begins sending
        // post data.
        postsFromLastStream = 0
        setTimeout(() => callback(null, response), DELAY)
      })
      .end()
  }),

  // The Pinboard API responds with a JSON Array.
  // Each Object in the Array is a post.
  jsonArrayStreams.parse(),

  // Filter only those posts without titles.
  through2.obj(function (post, _, done) {
    totalPosts++
    postsFromLastStream++
    if (totalPosts > LIMIT) {
      postsFromLastStream = 0
      return done()
    }
    if (
      post.href === post.description ||
      post.description === '[no title]'
    ) {
      if (post.href.endsWith('.pdf')) return done()
      this.push(post)
    }
    done()
  }),

  // For each short-URL post:
  flushWriteStream.obj((post, _, done) => {
    console.log(`Fetching Title for ${post.href}.`)
    findPageTitle(post.href, (error, title) => {
      if (error) {
        console.error(`Error fetching ${post.href}: ${error.toString()}`)
        return done()
      }
      if (!title) {
        console.error(`No title found for ${post.href}.`)
        return done()
      }
      console.log(`Title of ${post.href} is "${title}".`)
      replacePost(post, title, done)
    })
  }),

  error => {
    if (error) {
      console.error(error)
      process.exit(1)
    }
  }
)

function findPageTitle (url, callback) {
  const done = once(callback)
  http.request(url, {
    headers: {
      Accept: 'text/html',
      timeout: 3000
    }
  })
    .once('error', done)
    .once('response', response => {
      const chunks = []
      response
        .on('data', chunk => { chunks.push(chunk) })
        .once('error', done)
        .once('end', () => {
          const html = Buffer.concat(chunks).toString()
          const $ = cheerio.load(html)
          done(null, $('title').text())
        })
    })
    .end()
}

const POST_PROPERTIES = [
  'description', 'extended', 'tags', 'shared', 'toread'
]

function replacePost (post, title, callback) {
  const query = {
    auth_token: TOKEN,
    dt: post.time,
    url: post.href,
    toread: post.toread,
    shared: post.shared,
    tags: post.tags,
    replace: 'yes'
  }
  for (const key of POST_PROPERTIES) query[key] = post[key]
  query.description = title
  sendRequest({
    path: '/v1/posts/add?' + querystring.stringify(query)
  }, callback)
}

function sendRequest (options, callback) {
  options.protocol = 'https:'
  options.host = PINBOARD_API
  const done = once(callback)
  http.request(options)
    .once('error', done)
    .once('response', response => {
      const status = response.statusCode
      if (status === 200) {
        done()
      } else {
        done(new Error('The server responded ' + status + '.'))
      }
    })
    .end()
}
