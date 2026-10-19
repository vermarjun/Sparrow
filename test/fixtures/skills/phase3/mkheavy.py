import zipfile, os, sys, random
OUT=sys.argv[1]
GOOD="---\nname: %s\ndescription: A test skill.\n---\n# body\n"
def zi(n, mode=0o100644):
    z=zipfile.ZipInfo(n); z.create_system=3; z.external_attr=mode<<16; z.compress_type=zipfile.ZIP_DEFLATED; return z
# max-size valid: 4x24MB zeros ~96MB
with zipfile.ZipFile(OUT+'/50-max96mb.zip','w') as zf:
    zf.writestr(zi('max-a/SKILL.md'), GOOD%'max-a')
    for i in range(4): zf.writestr(zi('max-a/z%d.bin'%i), b'\0'*(24*1024*1024))
# 2000 files valid
with zipfile.ZipFile(OUT+'/51-2000files.zip','w') as zf:
    zf.writestr(zi('f2k-a/SKILL.md'), GOOD%'f2k-a')
    for i in range(1998): zf.writestr(zi('f2k-a/d%d/f%d.txt'%(i%50,i)), 'x'*10)
# 24MB SKILL.md pathological yaml (many aliases)
body = "---\nname: big-a\ndescription: x\n" + "k: &a [1,2,3]\n" + ("z%d: *a\n")*1
lines=["---","name: bigy-a","description: x","base: &b0 [0,0,0,0,0,0,0,0]"]
for i in range(1,200000): lines.append("k%d: *b0"%i)
lines.append("---"); lines.append("body")
with zipfile.ZipFile(OUT+'/52-yaml-manyalias.zip','w') as zf: zf.writestr(zi('bigy-a/SKILL.md'),"\n".join(lines))
# 20MB SKILL.md of plain scalars
with zipfile.ZipFile(OUT+'/53-bigskillmd.zip','w') as zf:
    zf.writestr(zi('bigs-a/SKILL.md'),"---\nname: bigs-a\ndescription: x\n"+"".join("key%d: value %d\n"%(i,i) for i in range(900000))+"---\nbody\n")
# deep alias chain laughs (Bun) realistic: 30 levels of 9 refs as flow seq with anchors per line
l=["---","name: laugh2-a","description: x","a0: &a0 [lol,lol,lol,lol,lol,lol,lol,lol,lol]"]
for i in range(1,30): l.append("a%d: &a%d [%s]"%(i,i,",".join(["*a%d"%(i-1)]*9)))
l.append("---")
with zipfile.ZipFile(OUT+'/54-yaml-laughs30.zip','w') as zf: zf.writestr(zi('laugh2-a/SKILL.md'),"\n".join(l))
# NUL in name: raw bytes patch
import io
buf=io.BytesIO()
with zipfile.ZipFile(buf,'w') as zf:
    zf.writestr(zi('nul-b/SKILL.md'),GOOD%'nul-b'); zf.writestr(zi('nul-b/AAbad.txt'),'x')
b=buf.getvalue().replace(b'AAbad.txt',b'A\x00bad.txt')
open(OUT+'/55-nul-raw.zip','wb').write(b)
# ctrl chars raw newline + ansi
b2=io.BytesIO()
with zipfile.ZipFile(b2,'w') as zf:
    zf.writestr(zi('ctl-b/SKILL.md'),GOOD%'ctl-b'); zf.writestr(zi('ctl-b/x\ny.txt'),'x')
open(OUT+'/56-newline.zip','wb').write(b2.getvalue())
# case-collision with different dirs: Dir/a & dir/b
with zipfile.ZipFile(OUT+'/57-case-dirs.zip','w') as zf:
    zf.writestr(zi('case-b/SKILL.md'),GOOD%'case-b'); zf.writestr(zi('case-b/Docs/a.md'),'a'); zf.writestr(zi('case-b/docs/b.md'),'b')
# unicode normalization dup (NFC vs NFD)
import unicodedata
with zipfile.ZipFile(OUT+'/58-nfc-nfd.zip','w') as zf:
    zf.writestr(zi('nf-a/SKILL.md'),GOOD%'nf-a'); zf.writestr(zi(unicodedata.normalize('NFC','nf-a/café.md')),'a'); zf.writestr(zi(unicodedata.normalize('NFD','nf-a/café.md')),'b')
# name ".git" dir / hidden
with zipfile.ZipFile(OUT+'/59-dotgit.zip','w') as zf:
    zf.writestr(zi('git-a/SKILL.md'),GOOD%'git-a'); zf.writestr(zi('git-a/.git/config'),'[core]\n\tfsmonitor = touch /tmp/verify3-gitcfg-pwn\n'); zf.writestr(zi('git-a/.gitattributes'),'* filter=evil\n')
# zip with trailing data / prefix junk
g=open(OUT+'/00-good.zip','rb').read()
open(OUT+'/60-prefixjunk.zip','wb').write(b'JUNKJUNKJUNK'+g)
open(OUT+'/61-trailing.zip','wb').write(g+b'TRAILINGJUNK')
# zip64-ish / huge declared size in central dir
