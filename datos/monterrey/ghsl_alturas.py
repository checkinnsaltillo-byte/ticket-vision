import math, numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
a=np.array(Image.open('GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100_V1_0_R6_C9.tif'))
X0,Y0=-10041000.0,4000000.0
la0,la1,lo0,lo1=25.10,26.50,-101.55,-99.60
S=0.001
R=6378137.0
nla=int(round((la1-la0)/S)); nlo=int(round((lo1-lo0)/S))
lat=la1-(np.arange(nla)+.5)*S; lon=lo0+(np.arange(nlo)+.5)*S
LA,LO=np.meshgrid(lat,lon,indexing='ij')
phi=np.radians(LA); th=phi.copy()
for _ in range(40):
    th-= (2*th+np.sin(2*th)-math.pi*np.sin(phi))/(2+2*np.cos(2*th)+1e-12)
x=R*2*math.sqrt(2)/math.pi*np.radians(LO)*np.cos(th); y=R*math.sqrt(2)*np.sin(th)
c=np.floor((x-X0)/100).astype(int); r=np.floor((Y0-y)/100).astype(int)
ok=(c>=0)&(c<a.shape[1])&(r>=0)&(r<a.shape[0])
v=np.zeros(LA.shape,np.float32); v[ok]=a[r[ok],c[ok]]; v[v<0]=0
q=np.clip(np.round(v/0.25),0,255).astype(np.uint8)
print(q.shape,(q>0).sum(),q.max(),ok.all())
# puntos de control
for n,(la,lo) in {'sal':(25.4225,-100.9990),'mty':(25.6866,-100.3161),'uanl':(25.7245,-100.3128)}.items():
    i=int((la1-la)/S);j=int((lo-lo0)/S);print(n,v[i-2:i+3,j-2:j+3].round(1).tolist())
import gzip,json
open('ghsl_R6C9.bin','wb').write(gzip.compress(q.tobytes(),9))
json.dump({'la0':la0,'la1':la1,'lo0':lo0,'lo1':lo1,'s':S,'ny':nla,'nx':nlo,'u':0.25},open('meta.json','w'))
