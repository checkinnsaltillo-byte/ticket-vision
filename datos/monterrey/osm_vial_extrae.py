import osmium, json, time
S,W,N,E = 25.211,-100.892,26.425,-99.656
EXC={"footway","steps","path","corridor","elevator","proposed","construction","bridleway","platform"}
t0=time.time(); ways=[]; n=0
fp = osmium.FileProcessor('mexico.osm.pbf', osmium.osm.NODE | osmium.osm.WAY).with_locations('sparse_file_array,idx.bin').with_filter(osmium.filter.KeyFilter('highway'))
for w in fp:
    if not w.is_way(): continue
    n+=1
    hw=w.tags.get('highway')
    if hw in EXC: continue
    try: pts=[(nd.lat,nd.lon) for nd in w.nodes if nd.location.valid()]
    except Exception: continue
    if len(pts)<2: continue
    if not any(S<=a<=N and W<=b<=E for a,b in pts): continue
    ways.append({"id":w.id,"tags":{t.k:t.v for t in w.tags},"geometry":[{"lat":a,"lon":b} for a,b in pts]})
    if n%500000==0: print(n,len(ways),round(time.time()-t0),'s',flush=True)
print('vías en bbox',len(ways),'de',n,round(time.time()-t0),'s')
json.dump(ways,open('ways_raw.json','w'))
