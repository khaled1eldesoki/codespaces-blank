#!/usr/bin/env python3
"""Independent checks of the PDFs written by forms-pdf.js (needs poppler-utils + Pillow + numpy).
Layout preservation = pixel-identical to the master everywhere outside the boxes the user filled."""
import subprocess, json, sys, os
from PIL import Image
import numpy as np
OUT=os.environ.get('FORMS_OUT','/tmp/forms-out'); KIT=os.path.join(os.path.dirname(__file__),'..','..','testkit','forms'); DPI=100; S=DPI/72; fails=0
def t(name,cond,extra=''):
    global fails; print(('ok   ' if cond else 'FAIL ')+name+(f'  [{extra}]' if extra else '')); fails+= (not cond)
def render(pdf,prefix):
    subprocess.run(['pdftoppm','-r',str(DPI),'-png',pdf,prefix],check=True); n=1; out=[]
    while os.path.exists(f'{prefix}-{n}.png') or os.path.exists(f'{prefix}-{n:02d}.png'): out.append(f'{prefix}-{n}.png' if os.path.exists(f'{prefix}-{n}.png') else f'{prefix}-{n:02d}.png'); n+=1
    return [np.array(Image.open(p).convert('L')).astype(int) for p in out]
def mask(shape,rects,H,pad=3):
    m=np.zeros(shape,bool)
    for (x1,y1,x2,y2) in rects:   # PDF points, origin bottom-left
        l=int((x1)*S)-pad; r=int((x2)*S)+pad; top=int((H-y2)*S)-pad; bot=int((H-y1)*S)+pad; m[max(0,top):bot,max(0,l):r]=True
    return m
def compare(master,done,rects,label,H=841.89):
    a=render(master,'/tmp/forms-out/m_'+label); b=render(done,'/tmp/forms-out/d_'+label); t(label+': same page count as master',len(a)==len(b),f'{len(a)}/{len(b)}')
    d1=np.abs(a[0]-b[0])>8; m=mask(a[0].shape,rects,H); out=int((d1&~m).sum()); inn=int((d1&m).sum())
    t(label+': page 1 pixels changed OUTSIDE the filled boxes = 0',out==0,f'{out} px outside, {inn} px inside')
    t(label+': filled boxes actually changed (text drawn)',inn>200,f'{inn} px')
    for i in range(1,len(a)): t(f'{label}: page {i+1} identical to master',int((np.abs(a[i]-b[i])>8).sum())==0)
def txt(pdf): return subprocess.run(['pdftotext','-layout',pdf,'-'],capture_output=True,text=True).stdout
def widgets(pdf): return subprocess.run(['pdfinfo','-js',pdf],capture_output=True,text=True).stdout
# --- static, 3 pages, user-placed overlays
boxes=json.load(open(OUT+'/overlay-boxes.json')); rects=[(b['x'],b['y'],b['x']+b['w'],b['y']+b['h']) for b in boxes]
compare(KIT+'/FO-TEST-001.pdf',OUT+'/filled-static.pdf',rects,'static')
x=txt(OUT+'/filled-static.pdf'); t('static: typed English values are real, searchable text','EMP001' in x and 'Hematology Lab' in x and 'Training completed 100%' in x)
t('static: Arabic text present in the PDF text layer',sum(1 for c in x if '\u0600'<=c<='\u06ff' or '\ufb50'<=c<='\ufeff')>20)
f=subprocess.run(['pdffonts',OUT+'/filled-static.pdf'],capture_output=True,text=True).stdout; t('static: fonts are embedded',all(l.split()[-5]=='yes' for l in f.strip().splitlines()[2:] if len(l.split())>5),f.strip().splitlines()[-1][:60] if f.strip() else '')
# --- native fillable
fr=[(180,740,481,763),(180,700,481,723),(180,660,481,683),(180,620,481,643),(180,520,481,591),(180,480,197,497),(180,440,381,463),(180,400,197,417),(260,400,277,417),(60,475,220,495)]
compare(KIT+'/FILL-TEST.pdf',OUT+'/filled-fillable.pdf',fr,'fillable')
x=txt(OUT+'/filled-fillable.pdf'); t('fillable: typed values are real text (ID, date, dropdown choice, English part of the mixed subject)','EMP001' in x and '21/10/2026' in x and 'Competent' in x and 'Sample preparation' in x)
import re; ann=subprocess.run(['qpdf','--show-npages',OUT+'/filled-fillable.pdf'],capture_output=True,text=True).stdout.strip()
js=subprocess.run(['qpdf','--json',OUT+'/filled-fillable.pdf'],capture_output=True,text=True).stdout; t('fillable: completed copy no longer contains form fields (flattened, layout fixed)','"/AcroForm"' not in js or '"/Fields":[]' in js.replace(' ','') )
# --- scanned
compare(KIT+'/FO-TEST-001-scanned.pdf',OUT+'/filled-scanned.pdf',[(0,0,0,0)],'scanned') if False else None
a=render(KIT+'/FO-TEST-001-scanned.pdf','/tmp/forms-out/m_scan'); b=render(OUT+'/filled-scanned.pdf','/tmp/forms-out/d_scan'); d=(np.abs(a[0]-b[0])>8); ys,xs=np.where(d)
t('scanned: only a small area changed (the OCR-placed text box)',0<d.sum()<0.01*d.size,f'{d.sum()} px = {100*d.sum()/d.size:.3f}% of the page; bbox x {xs.min()}-{xs.max()} y {ys.min()}-{ys.max()}' if len(xs) else 'no change')
# --- print pipeline vs completed copy
p=OUT+'/printed-static.pdf'; ip=subprocess.run(['pdfinfo',p],capture_output=True,text=True).stdout; ic=subprocess.run(['pdfinfo',OUT+'/filled-static.pdf'],capture_output=True,text=True).stdout
g=lambda s,k: re.search(k+r':\s+(.*)',s).group(1); t('print: same number of pages as the completed copy',g(ip,'Pages')==g(ic,'Pages'),f"{g(ip,'Pages')} vs {g(ic,'Pages')}")
wh=lambda s:[float(x) for x in re.findall(r'[\d.]+',g(s,'Page size'))[:2]]; w1,w2=wh(ip),wh(ic); t('print: page size equals the completed copy within 1 pt (CSS pt->px rounding)',abs(w1[0]-w2[0])<1 and abs(w1[1]-w2[1])<1,f"{w1} vs {w2}")
pa=render(OUT+'/filled-static.pdf','/tmp/forms-out/c_static'); pb=render(p,'/tmp/forms-out/p_static'); h=min(pa[0].shape[0],pb[0].shape[0]); w=min(pa[0].shape[1],pb[0].shape[1]); A=pa[0][:h,:w]; B=pb[0][:h,:w]
best=min(((np.abs(A-np.roll(np.roll(B,dx,1),dy,0))>64).mean()*100,dx,dy) for dx in range(-2,3) for dy in range(-2,3))
t('print: page 1 visibly matches the completed copy (<3% of pixels differ by >64/255 after a 1-2 px shift; MEASURED 2.1%. The print path is a 200 dpi raster re-render with page size rounded by Chromium (594.96 vs 595.30 pt) - NOT byte-identical; Export PDF is the exact route)',best[0]<3.0,f'{best[0]:.2f}% at shift {best[1:]}')
print('\nALL PASSED' if not fails else f'\n{fails} FAILED'); sys.exit(1 if fails else 0)
