import osmium, json, time, os, math, collections
S,W,N,E = 25.42,-100.50,25.86,-100.11; C=0.1
KN={"natural":{"tree":"t"},"highway":{"street_lamp":"l","traffic_signals":"s","crossing":"c","bus_stop":"b"},"public_transport":{"platform":"p"},"power":{"tower":"w"}}
TN={"crossing","crossing:markings","tactile_paving","kerb","name","shelter","bench","public_transport","voltage","highway","natural","power"}
TW={"building","building:levels","height","name","power","railway","waterway"}
def enc(pts):
    out=[]; la=ln=0
    def v(d):
        d=~(d<<1) if d<0 else d<<1; s=''
        while d>=0x20: s+=chr((0x20|(d&0x1f))+63); d>>=5
        return s+chr(d+63)
    for a,b in pts:
        ia,ib=round(a*1e6),round(b*1e6); out.append(v(ia-la)+v(ib-ln)); la,ln=ia,ib
    return ''.join(out)
tiles=collections.defaultdict(lambda:{"n":[],"w":[],"p":[],"a":[]})
AM={'hospital','clinic','school','university','college','place_of_worship','townhall','marketplace','police','fire_station','library','theatre','cinema','bus_station','fuel'}; SH={'mall','supermarket','department_store'}; LE={'park','stadium','sports_centre','garden'}; TO={'hotel','attraction','museum'}
def poi(t): return t.get('amenity') in AM or t.get('shop') in SH or t.get('leisure') in LE or t.get('tourism') in TO or t.get('place')=='square'
PT=('amenity','shop','leisure','tourism','place','name','building')
def tk(a,b): return f"{math.floor(a/C)}_{math.floor(b/C)}"
t0=time.time(); nn=nw=0
fp=osmium.FileProcessor('mexico.osm.pbf', osmium.osm.NODE|osmium.osm.WAY).with_locations('sparse_file_array,idx.bin').with_filter(osmium.filter.KeyFilter('natural','highway','public_transport','power','building','railway','waterway','amenity','shop','leisure','tourism','place'))
for o in fp:
    if o.is_node():
        la,lo=o.location.lat,o.location.lon
        if not(S<=la<=N and W<=lo<=E): continue
        t=o.tags; k=None
        if poi(t): tiles[tk(la,lo)]["p"].append([round(la,6),round(lo,6),{a.k:a.v for a in t if a.k in PT}])
        for key,m in KN.items():
            v=t.get(key)
            if v in m: k=m[v]; break
        if not k: continue
        if k=="w" and not t.get("voltage"): continue
        tiles[tk(la,lo)]["n"].append([round(la,6),round(lo,6),k,{a.k:a.v for a in t if a.k in TN and a.k not in("highway","natural","power") }]); nn+=1
    elif o.is_way():
        t=o.tags
        ak=None; sub=''
        if t.get('amenity')=='parking' and t.get('location') not in('underground',): ak='parking'; sub=t.get('parking','')
        elif t.get('leisure')=='pitch': ak='pitch'; sub=t.get('sport','')
        elif t.get('leisure')=='track': ak='track'; sub=t.get('sport','')
        elif t.get('leisure')=='swimming_pool': ak='pool'
        elif t.get('power') in('generator','plant') and (t.get('generator:source')=='solar' or t.get('plant:source')=='solar'): ak='solar'
        if ak:
            try:
                pa=[(x.lat,x.lon) for x in o.nodes if x.location.valid()]
                if len(pa)>=4 and S<=pa[0][0]<=N and W<=pa[0][1]<=E: tiles[tk(*pa[0])]["a"].append({"i":o.id,"k":ak,"s":sub.split(';')[0][:20],"g":enc(pa)})
            except Exception: pass
        t=o.tags; b=t.get("building"); pw=t.get("power")=="line"; rw=t.get("railway")=="rail"; wt=t.get("waterway") in("river","stream","canal","drain")
        if poi(t):
            try:
                pp=[(x.lat,x.lon) for x in o.nodes if x.location.valid()]
                if pp and S<=pp[0][0]<=N and W<=pp[0][1]<=E:
                    ca=sum(a for a,c in pp)/len(pp); co=sum(c for a,c in pp)/len(pp); tiles[tk(ca,co)]["p"].append([round(ca,6),round(co,6),{a.k:a.v for a in t if a.k in PT}])
            except Exception: pass
        if not(b or pw or rw or wt): continue
        try:
            n0=o.nodes[0].location
            if b and not(S<=n0.lat<=N and W<=n0.lon<=E): continue
            pts=[(x.lat,x.lon) for x in o.nodes if x.location.valid()]
        except Exception: continue
        if len(pts)<2: continue
        if b:
            if len(pts)<4: continue
            keys={tk(*pts[0])}
        else:
            if not any(S<=a<=N and W<=c<=E for a,c in pts): continue
            keys={tk(a,c) for a,c in pts}
        w={"i":o.id,"t":{a.k:a.v for a in t if a.k in TW},"g":enc(pts)}
        for kk in keys: tiles[kk]["w"].append(w)
        nw+=1
        if nw%200000==0: print(nw,round(time.time()-t0),'s',flush=True)
os.makedirs('ent',exist_ok=True); tot=0
for k,v in tiles.items():
    s=json.dumps(v,ensure_ascii=False,separators=(',',':')); open(f'ent/{k}.json','w').write(s); tot+=len(s)
json.dump({"at":__import__('datetime').datetime.utcnow().isoformat()+"Z","bbox":[S,W,N,E],"celda":C,"tiles":sorted(tiles)},open('ent/index.json','w'))
print('nodos',nn,'vías',nw,'tiles',len(tiles),round(tot/1e6,1),'MB',round(time.time()-t0),'s')
