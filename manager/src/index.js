// @ts-check
const { cli, logger, invariant } = require('tkt')
const fs = require('fs')
const path = require('path')
const { MongoClient } = require('mongodb')
const Bluebird = require('bluebird')
const axios = require('axios').default
const uuidv4 = require('uuid/v4')
const { generateReport } = require('./Reporting')
const { generatePlaylist } = require('./Playlist')

require('dotenv').config()
cli()
  .command(
    'import <file>',
    'Adds files to be processed',
    {
      file: {
        desc: 'JSON file of URLs, filename should be *.urls.json',
        type: 'string'
      },
      f: {
        desc: 'Apply the changes',
        type: 'boolean'
      }
    },
    async args => {
      const eventId = path.basename(args.file, '.urls.json')
      invariant(
        eventId.match(/^[a-z0-9]+$/),
        'Event ID must be an alphanumeric string; received: %s',
        eventId
      )
      const log = logger('import')
      const operations = JSON.parse(fs.readFileSync(args.file, 'utf8')).map(
        url => ({
          updateOne: {
            filter: { url },
            update: {
              $setOnInsert: { url, eventId: eventId, addedAt: new Date() }
            },
            upsert: true
          }
        })
      )
      log.info({ docs: operations }, 'Calculated operations to perform...')
      if (args.f) {
        const client = await connectToMongoDB()
        try {
          const result = await client
            .db()
            .collection('songs')
            .bulkWrite(operations)
          log.info({ result }, 'Bulk operation completed!')
        } finally {
          client.close()
        }
      }
    }
  )
  .command(
    'work',
    'Invokes the worker to process BMS archives',
    {},
    async args => {
      const log = logger('work')
      const client = await connectToMongoDB()
      try {
        const songsCollection = client.db().collection('songs')
        const found = await songsCollection
          .find({ 'renderResult.uploadedAt': { $exists: false } })
          .toArray()
        log.info('Found %s songs to work on.', found.length)
        await Bluebird.map(
          found,
          async song => {
            // @ts-ignore
            const operationId = uuidv4()
            const songLog = log.child(`${song._id}`)
            songLog.info('Start operation "%s"', operationId)
            try {
              const response = await axios.put(
                `${process.env.WORKER_URL}/renders/${operationId}`,
                { url: song.url },
                {
                  timeout: 900e3,
                  responseType: 'text',
                  transformResponse: undefined
                }
              )
              songLog.info('Operation "%s" finished', operationId)
              const result = JSON.parse(
                response.data
                  .split('\n')
                  .filter(r => r.trim())
                  .pop()
              )
              await songsCollection.updateOne(
                { _id: song._id },
                {
                  $set: {
                    renderResult: result,
                    renderedAt: new Date()
                  }
                }
              )
            } catch (error) {
              songLog.error({ err: error }, 'Cannot render!')
              await songsCollection.updateOne(
                { _id: song._id },
                {
                  $set: {
                    renderError:
                      String(error && error.stack) +
                      (error.response
                        ? `\nResponse: ${error.response.data}`
                        : ''),
                    renderedAt: new Date()
                  }
                }
              )
            }
          },
          { concurrency: 128 }
        )
      } finally {
        client.close()
      }
    }
  )
  .command(
    'playlist',
    'Prints the URLs of the songs as an M3U playlist',
    {
      eventId: { type: 'string', alias: ['e'], description: 'Filter by event' }
    },
    async args => {
      const log = logger('work')
      const client = await connectToMongoDB()
      try {
        console.log(await generatePlaylist(client, args))
      } finally {
        client.close()
      }
    }
  )
  .command('report', 'Generates a report', {}, async args => {
    const client = await connectToMongoDB()
    try {
      const report = await generateReport(client)
      console.log(JSON.stringify(report, null, 2))
    } finally {
      client.close()
    }
  })
  .command('server', 'Runs a server', {}, async args => {
    const client = await connectToMongoDB()
    const express = require('express')
    const app = express()
    app.use(express.static(__dirname + '/../static'))
    app.get('/report.json', async (req, res, next) => {
      try {
        const report = await generateReport(client)
        res.json(report)
      } catch (e) {
        next(e)
      }
    })
    app.listen(+process.env.PORT || 8080)
  })
  .parse()

async function connectToMongoDB() {
  const log = logger('mongodb')
  log.info('Connecting to MongoDB...')
  const client = new MongoClient(
    process.env.MONGO_URL ||
      invariant(false, 'Missing environment variable: MONGO_URL')
  )
  await client.connect()
  log.info('Connected to MongoDB!')
  return client
}
