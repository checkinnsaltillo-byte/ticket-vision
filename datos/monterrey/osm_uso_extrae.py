import osmium, json, time
S,W,N,E = 25.42,-100.50,25.86,-100.11
AM={"school","kindergarten","college","university","hospital","clinic","bank","restaurant","marketplace","fuel","pharmacy","cafe","townhall"}; LU={"residential","commercial","retail","industrial"}
def enc(pts):
    out=[]; la=ln=0
    def v(d):
        d=~(d<<1) if d<0 else d<<1; s=''
        while d>=0x20: s+=chr((0x20|(d&0x1f))+63); d>>=5
        return s+chr(d+63)
    for a,b in pts:
        ia,ib=round(a*1e6),round(b*1e6); out.append(v(ia-la)+v(ib-ln)); la,ln=ia,ib
    return ''.join(out)
nodes=[]; ways=[]; t0=time.time()
fp=osmium.FileProcessor('mexico.osm.pbf', osmium.osm.NODE|osmium.osm.WAY).with_locations('sparse_file_array,idx.bin').with_filter(osmium.filter.KeyFilter('shop','office','amenity','landuse','man_made'))
for o in fp:
    t=o.tags
    if o.is_node():
        la,lo=o.location.lat,o.location.lon
        if not(S<=la<=N and W<=lo<=E): continue
        if t.get('shop') or t.get('office') or t.get('amenity') in AM: nodes.append([round(la,6),round(lo,6)])
    elif o.is_way():
        if t.get('landuse') not in LU and t.get('man_made')!='pipeline': continue
        try:
            if not(S<=o.nodes[0].location.lat<=N and W<=o.nodes[0].location.lon<=E): continue
            pts=[(x.lat,x.lon) for x in o.nodes if x.location.valid()]
        except Exception: continue
        if len(pts)>=3: ways.append({"i":o.id,"t":({"man_made":"pipeline"} if t.get('man_made')=='pipeline' else {"landuse":t.get('landuse')}),"g":enc(pts)})
json.dump({"at":__import__('datetime').datetime.utcnow().isoformat()+"Z","bbox":[S,W,N,E],"nodes":nodes,"ways":ways},open('uso-monterrey.json','w'),separators=(',',':'))
print('nodos',len(nodes),'landuse',len(ways),round(time.time()-t0),'s')
