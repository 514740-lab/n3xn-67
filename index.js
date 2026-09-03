import express from 'express'
import basicAuth from 'express-basic-auth'
import http from 'node:http'
import path from 'node:path'
import cors from 'cors'
import { createBareServer } from '@tomphttp/bare-server-node'
import config from './config.js'

const __dirname = process.cwd()
const server = http.createServer()
const app = express()
const bareServer = createBareServer('/v/')
const PORT = 8080

if (config.challenge) {
  console.log(
    'Password protection is enabled. Usernames are: ' +
      Object.keys(config.users)
  )

  console.log(
    'Passwords are: ' +
      Object.values(config.users)
  )

  app.use(basicAuth(config))
}

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cors())

/*
 * ============================================================
 * /html
 *
 * Format:
 *
 * /html/<content-type>/<encoding>/<payload>
 *
 * Example:
 *
 * /html/text$;plain/plain/67
 *
 * Returns:
 *
 * Content-Type: text/plain
 * Body: 67
 *
 * MIME types use $; instead of /:
 *
 * text$;plain       -> text/plain
 * text$;html        -> text/html
 * application$;json -> application/json
 *
 * Encodings:
 *
 * plain
 * uri
 * base64
 *
 * URL proxy mode:
 *
 * /html/text$;html/plain/$:https://example.com
 *
 * The $: prefix means fetch the target URL.
 * ============================================================
 */

app.get('/html/*', async (req, res) => {
  try {
    const raw = req.params[0]

    if (!raw) {
      return res.status(400).send(
        'Missing content type, encoding, and payload.'
      )
    }

    /*
     * Split:
     *
     * <content-type>/<encoding>/<payload>
     */

    const firstSlash = raw.indexOf('/')

    if (firstSlash === -1) {
      return res.status(400).send(
        'Missing encoding and payload.'
      )
    }

    const contentTypeEncoded =
      raw.slice(0, firstSlash)

    const remaining =
      raw.slice(firstSlash + 1)

    const secondSlash =
      remaining.indexOf('/')

    if (secondSlash === -1) {
      return res.status(400).send(
        'Missing payload.'
      )
    }

    const encoding =
      remaining
        .slice(0, secondSlash)
        .toLowerCase()

    let payload =
      remaining.slice(secondSlash + 1)

    /*
     * Convert:
     *
     * text$;plain
     *
     * into:
     *
     * text/plain
     */

    const contentType =
      contentTypeEncoded.replace(/\$;/g, '/')

    /*
     * Basic MIME type validation.
     */

    if (
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
        contentType
      )
    ) {
      return res.status(400).send(
        'Invalid content type.'
      )
    }

    /*
     * ========================================================
     * Decode payload
     * ========================================================
     */

    if (
      encoding === 'uri' ||
      encoding === 'url' ||
      encoding === 'uri-component'
    ) {
      try {
        payload = decodeURIComponent(payload)
      } catch {
        return res.status(400).send(
          'Invalid URI encoding.'
        )
      }
    }

    else if (
      encoding === 'base64' ||
      encoding === 'b64'
    ) {
      try {
        let value = payload
          .replace(/-/g, '+')
          .replace(/_/g, '/')

        while (value.length % 4 !== 0) {
          value += '='
        }

        payload =
          Buffer.from(
            value,
            'base64'
          ).toString('utf8')
      } catch {
        return res.status(400).send(
          'Invalid Base64 data.'
        )
      }
    }

    else if (encoding === 'plain') {
      /*
       * Leave payload untouched.
       */
    }

    else {
      return res.status(400).send(
        'Unsupported encoding. Use plain, uri, or base64.'
      )
    }

    /*
     * ========================================================
     * $: URL mode
     *
     * Example:
     *
     * /html/text$;html/plain/$:https://example.com
     *
     * or:
     *
     * /html/text$;html/uri/$:https%3A%2F%2Fexample.com
     *
     * The payload has already been decoded according to the
     * selected encoding.
     * ========================================================
     */

    if (payload.startsWith('$:')) {
      let target = payload.slice(2)

      target = target.trim()

      /*
       * If there is no scheme, assume HTTPS.
       */

      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
        target = 'https://' + target
      }

      let targetURL

      try {
        targetURL = new URL(target)
      } catch {
        return res.status(400).send(
          'Invalid target URL.'
        )
      }

      /*
       * Only permit HTTP(S) targets.
       */

      if (
        targetURL.protocol !== 'http:' &&
        targetURL.protocol !== 'https:'
      ) {
        return res.status(400).send(
          'Only HTTP and HTTPS URLs are supported.'
        )
      }

      try {
        const upstream = await fetch(
          targetURL.toString(),
          {
            method: 'GET',
            redirect: 'follow',
            headers: {
              'user-agent':
                req.get('user-agent') ||
                'Mozilla/5.0',
              'accept':
                req.get('accept') ||
                '*/*'
            }
          }
        )

        const body =
          Buffer.from(
            await upstream.arrayBuffer()
          )

        res.status(upstream.status)

        /*
         * Return the content using the MIME type requested
         * in the /html URL.
         */

        res.setHeader(
          'Content-Type',
          contentType
        )

        /*
         * Do not let an upstream Content-Length become stale
         * after processing.
         */

        res.removeHeader(
          'Content-Length'
        )

        return res.end(body)

      } catch (error) {
        console.error(
          'HTML URL fetch failed:',
          error
        )

        return res.status(502).send(
          'Unable to fetch target URL.'
        )
      }
    }

    /*
     * ========================================================
     * Normal content mode
     * ========================================================
     */

    res.status(200)

    res.setHeader(
      'Content-Type',
      contentType
    )

    res.setHeader(
      'Cache-Control',
      'no-store'
    )

    return res.send(payload)

  } catch (error) {
    console.error(
      'HTML endpoint error:',
      error
    )

    if (!res.headersSent) {
      return res.status(500).send(
        'Internal server error.'
      )
    }
  }
})

/*
 * ============================================================
 * /url
 *
 * Serves URL.html for:
 *
 * /url
 * /url/anything
 * ============================================================
 */

app.get(
  ['/url', '/url/*'],
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        'static',
        'URL.html'
      )
    )
  }
)

/*
 * ============================================================
 * Existing static files
 * ============================================================
 */

app.use(
  express.static(
    path.join(__dirname, 'static')
  )
)

/*
 * ============================================================
 * Existing remote content routes
 * ============================================================
 */

const fetchData = async (
  req,
  res,
  next,
  baseUrl
) => {
  try {
    const reqTarget =
      `${baseUrl}/${req.params[0]}`

    const asset =
      await fetch(reqTarget)

    if (asset.ok) {
      const data =
        await asset.arrayBuffer()

      res.end(
        Buffer.from(data)
      )
    } else {
      next()
    }
  } catch (error) {
    console.error(
      'Error fetching:',
      error
    )

    next(error)
  }
}

app.get(
  '/y/*',
  cors({ origin: false }),
  (req, res, next) => {
    const baseUrl =
      'https://raw.githubusercontent.com/ypxa/y/main'

    fetchData(
      req,
      res,
      next,
      baseUrl
    )
  }
)

app.get(
  '/f/*',
  cors({ origin: false }),
  (req, res, next) => {
    const baseUrl =
      'https://raw.githubusercontent.com/4x-a/x/fixy'

    fetchData(
      req,
      res,
      next,
      baseUrl
    )
  }
)

/*
 * ============================================================
 * /x
 *
 * Server-side fetch proxy.
 *
 * Example:
 *
 * /x/https://example.com
 *
 * or URI encoded:
 *
 * /x/https%3A%2F%2Fexample.com
 * ============================================================
 */

app.get('/x/*', cors(), async (req, res) => {
  try {
    let target =
      req.params[0]

    try {
      target =
        decodeURIComponent(target)
    } catch {
      return res.status(400).send(
        'Invalid URI encoding.'
      )
    }

    target =
      target.trim()

    /*
     * Allow bare domains.
     */

    if (
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(
        target
      )
    ) {
      target =
        'https://' + target
    }

    let targetURL

    try {
      targetURL =
        new URL(target)
    } catch {
      return res.status(400).send(
        'Invalid URL.'
      )
    }

    if (
      targetURL.protocol !== 'http:' &&
      targetURL.protocol !== 'https:'
    ) {
      return res.status(400).send(
        'Only HTTP and HTTPS URLs are supported.'
      )
    }

    const upstream =
      await fetch(
        targetURL.toString(),
        {
          redirect: 'follow',
          headers: {
            'user-agent':
              req.get('user-agent') ||
              'Mozilla/5.0',

            accept:
              req.get('accept') ||
              '*/*'
          }
        }
      )

    res.status(
      upstream.status
    )

    /*
     * Copy safe upstream headers.
     */

    upstream.headers.forEach(
      (value, key) => {
        if (
          ![
            'content-encoding',
            'content-length',
            'transfer-encoding',
            'connection',
            'set-cookie',
            'access-control-allow-origin'
          ].includes(
            key.toLowerCase()
          )
        ) {
          res.setHeader(
            key,
            value
          )
        }
      }
    )

    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    )

    const data =
      Buffer.from(
        await upstream.arrayBuffer()
      )

    return res.end(data)

  } catch (error) {
    console.error(
      'Error fetching /x target:',
      error
    )

    if (!res.headersSent) {
      return res.status(502).send(
        'Unable to fetch URL.'
      )
    }
  }
})

/*
 * ============================================================
 * Existing page routes
 * ============================================================
 */

const routes = [
  {
    path: '/',
    file: 'index.html'
  },
  {
    path: '/~',
    file: 'apps.html'
  },
  {
    path: '/-',
    file: 'games.html'
  },
  {
    path: '/!',
    file: 'settings.html'
  },
  {
    path: '/0',
    file: 'tabs.html'
  },
  {
    path: '/&',
    file: 'go.html'
  },
  {
    path: '/w',
    file: 'edu.html'
  },
  {
    path: '/e',
    file: 'now.html'
  }
]

routes.forEach(
  route => {
    app.get(
      route.path,
      (req, res) => {
        res.sendFile(
          path.join(
            __dirname,
            'static',
            route.file
          )
        )
      }
    )
  }
)

/*
 * ============================================================
 * Bare server / WebSocket handling
 * ============================================================
 */

const handler = (
  req,
  res
) => {
  if (
    bareServer.shouldRoute(req)
  ) {
    return bareServer.routeRequest(
      req,
      res
    )
  }

  return app(
    req,
    res
  )
}

server.on(
  'request',
  handler
)

server.on(
  'upgrade',
  (req, socket, head) => {
    if (
      bareServer.shouldRoute(req)
    ) {
      bareServer.routeUpgrade(
        req,
        socket,
        head
      )
    } else {
      socket.end()
    }
  }
)

/*
 * ============================================================
 * Server startup
 * ============================================================
 */

server.on(
  'listening',
  () => {
    console.log(
      `Running at http://localhost:${PORT}`
    )
  }
)

/*
 * Vercel serverless handler.
 */

export default handler

/*
 * Normal local/server deployment.
 */

if (!process.env.VERCEL) {
  server.listen({
    port: PORT
  })
}
