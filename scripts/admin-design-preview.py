"""Build a standalone fictional preview. Never serves the production admin directly."""
from pathlib import Path
import re
source=Path(__file__).resolve().parents[1]/'admin.html'
s=source.read_text()
s=re.sub(r'<script src="[^"]+"></script>','',s)
s=re.sub(r'<link rel="stylesheet"[^>]+>','',s)
s=s.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; connect-src \'none\'; img-src data:">')
s=re.sub(r'const API_BASE = .*?;',"const API_BASE = '/preview-disabled';",s,count=1)
s=re.sub(r'let adminSecret = .*?;',"let adminSecret = '';",s,count=1)
start=s.index('async function adminFetch(');end=s.index('\nasync function login()',start)
s=s[:start]+'''async function adminFetch(path,opts={}) {
 if(opts.method && opts.method!=='GET') throw new Error('Preview only: changes and sending are disabled.');
 if(path==='/announcements')return {announcements:[]};
 if(path==='/admin/overview')return {users:{total_users:512,active_7d:86,new_users_7d:23,active_24h:31},swaps:{total_swaps:248,completed:196,active:18},matches:{pending_matches:42}};
 if(path==='/admin/analytics')return [{id:1,name:'Alex Morgan',email:'alex@example.test',email_verified:true,duplicates_count:42,needs_count:18,swaps_count:12,completed_swaps:10,created_at:'2026-09-01',last_login_at:'2026-09-24',reviews:[]}];
 if(path.includes('click-stats'))return {total:148,today:9,widget:63,banner:85,uniqueUsers:112};
 if(path.includes('collection-sharing-stats'))return {totals:{links_created:24,sharers:18,signups:12,qualified:5,active_links:21,badge_holders:4},albumChoices:[{id:1,name:'World Cup Stickers 2026'},{id:2,name:'Premier League Trading Cards 2026/27'}],albums:[{id:1,name:'World Cup Stickers 2026',links_created:10,signups:4,qualified:2},{id:2,name:'Premier League Trading Cards 2026/27',links_created:14,signups:8,qualified:3}],leaders:[{name:'Alex Morgan',signups:7,qualified:3},{name:'Sam Wilson',signups:5,qualified:2}],daily:[{day:'2026-09-23',links:10,signups:4},{day:'2026-09-24',links:14,signups:8}]};
 return [];
}
''' +s[end:]
s=s.replace('<body>','<body><div style="padding:10px;text-align:center;background:#ffcf25;font-size:12px">DESIGN PREVIEW · fictional data · sending disabled</div>')
s=s.rsplit('</body>',1)[0]+'''<script>window.fetch=async()=>{throw Error('Preview network disabled');};document.getElementById('login').style.display='none';document.getElementById('dashboard').style.display='block';document.getElementById('bottomNav').style.display='block';showTab('overview');</script></body>'''
out=Path('/tmp/gos-sharing-preview');out.mkdir(exist_ok=True);(out/'index.html').write_text(s)
print(out/'index.html')
