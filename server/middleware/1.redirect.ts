import type { LinkSchema } from '@@/schemas/link'
import type { z } from 'zod'
import { parsePath, withQuery } from 'ufo'

export default eventHandler(async (event) => {
  const { pathname: slug } = parsePath(event.path.replace(/^\/|\/$/g, ''))
  const { slugRegex, reserveSlug } = useAppConfig(event)
  const { homeURL, linkCacheTtl, redirectWithQuery, caseSensitive, turnstileSecretKey } = useRuntimeConfig(event)
  const { cloudflare } = event.context

  if (event.path === '/' && homeURL)
    return sendRedirect(event, homeURL)

  if (slug && !reserveSlug.includes(slug) && slugRegex.test(slug) && cloudflare) {
    const { KV } = cloudflare.env
    let link: z.infer<typeof LinkSchema> | null = null

    const getLink = async (key: string) =>
      await KV.get(`link:${key}`, { type: 'json', cacheTtl: linkCacheTtl })

    const lowerCaseSlug = slug.toLowerCase()
    link = await getLink(caseSensitive ? slug : lowerCaseSlug)

    if (!caseSensitive && !link && lowerCaseSlug !== slug) {
      link = await getLink(slug)
    }

    if (link) {
      const { turnstileSiteKey } = useRuntimeConfig(event).public

      // Skip Turnstile if not configured
      if (!turnstileSecretKey || !turnstileSiteKey) {
        event.context.link = link
        try {
          await useAccessLog(event)
        } catch (error) {
          console.error('Failed write access log:', error)
        }
        const target = redirectWithQuery ? withQuery(link.url, getQuery(event)) : link.url
        return sendRedirect(event, target, +useRuntimeConfig(event).redirectStatusCode)
      }

      // POST = Turnstile verification
      if (event.method === 'POST') {
        const body = await readBody(event)
        const ip = getHeader(event, 'cf-connecting-ip') || ''

        const result: { success: boolean } = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret: turnstileSecretKey,
            response: body.token,
            remoteip: ip
          })
        }).then(r => r.json())

        if (!result.success) {
          throw createError({ statusCode: 403, message: 'Verification failed' })
        }

        // Passed - log and redirect
        event.context.link = link
        try {
          await useAccessLog(event)
        } catch (error) {
          console.error('Failed write access log:', error)
        }

        const target = redirectWithQuery ? withQuery(link.url, getQuery(event)) : link.url
        return sendRedirect(event, target, +useRuntimeConfig(event).redirectStatusCode)
      }

      // GET = Serve Turnstile interstitial
      setResponseHeader(event, 'Content-Type', 'text/html')
      return getTurnstileHTML(turnstileSiteKey)
    }
  }
})

function getTurnstileHTML(siteKey: string) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Redirecting...</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
    .container{text-align:center}
    .spinner{width:40px;height:40px;border:3px solid #ddd;border-top-color:#333;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .error{color:#c00;display:none}
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p>Verifying...</p>
    <p class="error" id="error">Verification failed. Please refresh.</p>
    <div class="cf-turnstile" data-sitekey="${siteKey}" data-callback="onSuccess" data-size="invisible"></div>
  </div>
  <script>
    function onSuccess(token) {
      fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      }).then(r => {
        if (r.redirected) window.location.href = r.url
        else { document.getElementById('error').style.display = 'block'; document.querySelector('.spinner').style.display = 'none' }
      }).catch(() => {
        document.getElementById('error').style.display = 'block'
        document.querySelector('.spinner').style.display = 'none'
      })
    }
  </script>
</body>
</html>`
}
