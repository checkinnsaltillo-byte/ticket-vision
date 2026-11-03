import json, datetime
S,W,N,E = 25.211,-100.892,26.425,-99.656
KEEP={"highway","name","ref","oneway","junction","lanes","lanes:forward","lanes:backward","maxspeed","width","surface","bridge","tunnel","layer","sidewalk","service","access","lit"}
def enc(pts):
    out=[]; la=ln=0
    def v(d):
        d=~(d<<1) if d<0 else d<<1; s=''
        while d>=0x20: s+=chr((0x20|(d&0x1f))+63); d>>=5
        return s+chr(d+63)
    for a,b in pts:
        ia,ib=round(a*1e6),round(b*1e6); out.append(v(ia-la)+v(ib-ln)); la,ln=ia,ib
    return ''.join(out)
raw=json.load(open('ways_raw.json')); ways=[]
for w in raw:
    g=[(p['lat'],p['lon']) for p in w.get('geometry',[]) if p]
    if len(g)<2: continue
    t={k:v for k,v in w.get('tags',{}).items() if k in KEEP or k.startswith('parking:')}
    ways.append({"i":w['id'],"t":t,"g":enc(g)})
out={"at":datetime.datetime.utcnow().isoformat()+"Z","bbox":[S,W,N,E],"fuente":"OpenStreetMap (Overpass), highway sin footway/steps/path…","ways":ways}
json.dump(out,open('vial-monterrey.json','w'),ensure_ascii=False,separators=(',',':'))
import os; print(len(ways),'vías', round(os.path.getsize('vial-monterrey.json')/1e6,1),'MB')
