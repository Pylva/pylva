import { env } from '@/lib/config';

type AnalyticsSurface = 'marketing' | 'docs' | 'auth' | 'app';

const POSTHOG_HOSTS = new Set([
  'app.posthog.com',
  'us.i.posthog.com',
  'eu.i.posthog.com',
]);

function posthogCaptureEndpoint(host: string | undefined): string | null {
  if (!host) return null;
  try {
    const url = new URL(host);
    if (url.protocol !== 'https:' || !POSTHOG_HOSTS.has(url.hostname)) return null;
    url.pathname = '/capture/';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function htmlScriptJson(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\//g, '\\u002f');
}

export function PageViewBeacon({ surface }: { surface: AnalyticsSurface }) {
  const endpoint = posthogCaptureEndpoint(env.NEXT_PUBLIC_POSTHOG_HOST);
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!endpoint || !key || env.NODE_ENV === 'test') return null;

  const script = `(function(){var endpoint=${htmlScriptJson(endpoint)},apiKey=${htmlScriptJson(key)},surface=${htmlScriptJson(surface)},lastPath="";function id(){try{var k="pylva:ph_did",v=localStorage.getItem(k);if(v)return v;v=(crypto&&crypto.randomUUID)?crypto.randomUUID():"anon_"+Date.now()+"_"+Math.random().toString(36).slice(2);localStorage.setItem(k,v);return v}catch(e){return"anon"}}function send(){var path=location.pathname;if(path===lastPath)return;lastPath=path;var body=JSON.stringify({api_key:apiKey,event:"page_viewed",properties:{surface:surface,path:path},distinct_id:id(),timestamp:new Date().toISOString()});if(navigator.sendBeacon){navigator.sendBeacon(endpoint,new Blob([body],{type:"application/json"}));return}fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true}).catch(function(){})}["pushState","replaceState"].forEach(function(name){var original=history[name];history[name]=function(){var result=original.apply(this,arguments);setTimeout(send,0);return result}});addEventListener("popstate",send);send()})();`;
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
