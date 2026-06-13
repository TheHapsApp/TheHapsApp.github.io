/* PostHog web analytics — official loader stub + init.
   Shared by every page; this is the only place the token/config lives.
   Docs: https://posthog.com/docs/libraries/js */
!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init os ds Ie us vs ss ls capture calculateEventProperties register register_once register_for_session unregister unregister_for_session ws getFeatureFlag getFeatureFlagPayload getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty bs ps createPersonProfile setInternalOrTestUser ys es $s opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing cs debug M gs getPageViewId captureTraceFeedback captureTraceMetric Qr".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
/* Self-exclusion: load any page once with ?ph_optout=1 to stop PostHog from
   capturing this browser (persists in localStorage); ?ph_optout=0 re-enables.
   Decided synchronously before init so not even the first pageview leaks, then
   reinforced with an explicit opt-out so has_opted_out_capturing() reports it. */
var phParam = null, phOptedOut = false;
try {
  phParam = new URLSearchParams(location.search).get('ph_optout');
  if (phParam === '1' || phParam === '0') localStorage.setItem('ph_optout', phParam);
  phOptedOut = localStorage.getItem('ph_optout') === '1';
} catch (e) { /* private mode / storage blocked — just track normally */ }

posthog.init('phc_kdA422xs2LCRJ8fLKwB79APgs8JevXyTi5gJVjxMzkux', {
    api_host: 'https://us.i.posthog.com',
    defaults: '2026-01-30',
    opt_out_capturing_by_default: phOptedOut
});

if (phOptedOut) {
  posthog.opt_out_capturing();          // explicit "denied" — persists + reported by has_opted_out_capturing()
} else if (phParam === '0') {
  posthog.opt_in_capturing();           // re-enable a browser that was previously opted out
}

/* App-download funnel: named events on top of autocapture.
   get_app_click  = any "Get the app" CTA (links to /beta)
   app_store_click = an actual store link (App Store badge / Play opt-in).
   Capture phase so site JS that stops propagation can't swallow these. */
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  var href = a.getAttribute('href') || '';
  if (href.indexOf('apps.apple.com') !== -1) {
    posthog.capture('app_store_click', { store: 'ios', href: href, page: location.pathname });
  } else if (href.indexOf('play.google.com') !== -1) {
    posthog.capture('app_store_click', { store: 'android', href: href, page: location.pathname });
  } else if (href === '/beta' || href.indexOf('/beta/') === 0) {
    posthog.capture('get_app_click', {
      page: location.pathname,
      cta_text: (a.textContent || '').trim().slice(0, 60)
    });
  }
}, true);
