import urllib.request, gzip, json, math, os, collections, re, io
S,W,N,E = 25.42,-100.50,25.86,-100.11; C=0.1
txt=urllib.request.urlopen("https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv",timeout=90).read().decode()
m={}
for l in txt.split("\n"):
    if l.startswith("Mexico,"): c=l.split(","); m[c[1]]=c[2]
def qk(lat,lng,z=9):
    n=2**z; x=int((lng+180)/360*n); sn=math.sin(lat*math.pi/180); y=int((0.5-math.log((1+sn)/(1-sn))/(4*math.pi))*n); q=''
    for i in range(z,0,-1):
        d=0; mk=1<<(i-1)
        if x&mk: d+=1
        if y&mk: d+=2
        q+=str(d)
    return q
ks=set(qk(a,b) for a in [S,(S+N)/2,N] for b in [W,(W+E)/2,E])
def enc(pts):
    out=[]; la=ln=0
    def v(d):
        d=~(d<<1) if d<0 else d<<1; s=''
        while d>=0x20: s+=chr((0x20|(d&0x1f))+63); d>>=5
        return s+chr(d+63)
    for a,b in pts:
        ia,ib=round(a*1e6),round(b*1e6); out.append(v(ia-la)+v(ib-ln)); la,ln=ia,ib
    return ''.join(out)
tiles=collections.defaultdict(list); n=0
for k in sorted(ks):
    u=m.get(k)
    if not u: continue
    print('bajando',k,flush=True)
    data=urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"checkinn/1.0"}),timeout=300).read()
    for line in gzip.GzipFile(fileobj=io.BytesIO(data)):
        try: j=json.loads(line)
        except Exception: continue
        ring=(j.get('geometry') or {}).get('coordinates',[[]])[0]
        if len(ring)<4: continue
        pts=[(q[1],q[0]) for q in ring[:-1]]
        ca=sum(a for a,b in pts)/len(pts); co=sum(b for a,b in pts)/len(pts)
        if not(S<=ca<=N and W<=co<=E): continue
        tiles[f"{math.floor(ca/C)}_{math.floor(co/C)}"].append(enc(pts)); n+=1
os.makedirs('huellas',exist_ok=True); tot=0
for k,v in tiles.items():
    s=json.dumps({"f":v},separators=(',',':')); open(f'huellas/{k}.json','w').write(s); tot+=len(s)
json.dump({"at":__import__('datetime').datetime.utcnow().isoformat()+"Z","bbox":[S,W,N,E],"celda":C,"tiles":sorted(tiles),"fuente":"Microsoft Global ML Building Footprints (ODbL)"},open('huellas/index.json','w'))
print('huellas',n,'tiles',len(tiles),round(tot/1e6,1),'MB')
