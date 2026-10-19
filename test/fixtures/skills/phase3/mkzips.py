import zipfile, os, struct, zlib, io, sys
OUT = sys.argv[1]
GOOD = "---\nname: %s\ndescription: A test skill.\n---\n# body\n"
def zi(name, mode=0o100644, system=3, ctype=zipfile.ZIP_DEFLATED):
    z = zipfile.ZipInfo(name)
    z.create_system = system
    z.external_attr = (mode << 16)
    z.compress_type = ctype
    return z
def save(name, entries, comment=None):
    with zipfile.ZipFile(os.path.join(OUT, name), 'w') as zf:
        for item in entries:
            info, data = item
            zf.writestr(info, data)
    print('wrote', name)
ok = lambda n: (zi('%s/SKILL.md' % n), GOOD % n)
save('00-good.zip', [ok('good-skill')])
save('01-slip-dotdot.zip', [ok('slip-a'), (zi('slip-a/../../escape.txt'), 'x')])
save('02-slip-leading.zip', [ok('slip-b'), (zi('../escape2.txt'), 'x')])
save('03-slip-backslash.zip', [ok('slip-c'), (zi('slip-c\\..\\..\\escape3.txt'), 'x')])
save('04-abs.zip', [ok('abs-a'), (zi('/tmp/escape4.txt'), 'x')])
save('05-drive.zip', [ok('drive-a'), (zi('C:/escape5.txt'), 'x')])
save('06-symlink-passwd.zip', [ok('sym-a'), (zi('sym-a/link', 0o120777), '/etc/passwd')])
save('07-symlink-dotdot.zip', [ok('sym-b'), (zi('sym-b/link', 0o120777), '../..')])
save('08-symlink-sibling.zip', [ok('sym-c'), (zi('sym-c/real.txt'), 'x'), (zi('sym-c/link', 0o120777), 'real.txt')])
save('08b-symlink-madeby0.zip', [ok('sym-d'), (zi('sym-d/link', 0o120777, system=0), '/etc/passwd')])
save('09-dup-case.zip', [ok('case-a'), (zi('case-a/README.md'), 'one'), (zi('case-a/readme.md'), 'two')])
save('10-file-and-dir.zip', [ok('fd-a'), (zi('fd-a/thing'), 'file'), (zi('fd-a/thing/'  , 0o040755), ''), (zi('fd-a/thing/inner'), 'x')])
save('10b-file-then-child.zip', [ok('fd-b'), (zi('fd-b/thing'), 'file'), (zi('fd-b/thing/inner'), 'x')])
save('11-nul.zip', [ok('nul-a'), (zi('nul-a/bad\0name.txt'), 'x')])
save('12-ctrl.zip', [ok('ctrl-a'), (zi('ctrl-a/bad\nname\x1b[31m.txt'), 'x')])
save('13-longname.zip', [ok('long-a'), (zi('long-a/' + 'a'*300 + '.txt'), 'x')])
save('13b-longpath.zip', [ok('long-b'), (zi('long-b/' + '/'.join(['d'*100]*50) + '/f.txt'), 'x')])
# 10k files
save('14-10kfiles.zip', [ok('many-a')] + [(zi('many-a/f/%d.txt' % i), 'x') for i in range(10000)])
save('14b-2001files.zip', [ok('many-b')] + [(zi('many-b/f/%d.txt' % i), 'x') for i in range(2000)])
# zip bomb: 90MB of zeros in one entry (declared size < 100MB total), plus many
big = b'\0' * (24*1024*1024)
save('15-bomb-24mb.zip', [ok('bomb-a'), (zi('bomb-a/zeros.bin'), big)])
save('15b-bomb-100mb.zip', [ok('bomb-b')] + [(zi('bomb-b/z%d.bin' % i), big) for i in range(5)])
save('15c-bomb-30mb-single.zip', [ok('bomb-c'), (zi('bomb-c/z.bin'), b'\0'*(30*1024*1024))])
open(os.path.join(OUT, '16-empty0.zip'), 'wb').close()
open(os.path.join(OUT, '17-not-a-zip.zip'), 'wb').write(b'this is not a zip file at all' * 100)
# truncated zip
g = open(os.path.join(OUT, '00-good.zip'), 'rb').read()
open(os.path.join(OUT, '18-truncated.zip'), 'wb').write(g[:len(g)//2])
# empty valid zip (EOCD only)
open(os.path.join(OUT, '19-empty-valid.zip'), 'wb').write(b'PK\x05\x06' + b'\0'*18)
# nested zip
inner = io.BytesIO()
with zipfile.ZipFile(inner, 'w') as zf: zf.writestr('inner-skill/SKILL.md', GOOD % 'inner-skill')
save('20-nested.zip', [(zi('nest-a/SKILL.md'), GOOD % 'nest-a'), (zi('nest-a/inner.zip'), inner.getvalue())])
save('20b-nested-only.zip', [(zi('inner.zip'), inner.getvalue())])
# SKILL.md issues
save('21-badname.zip', [(zi('bad-a/SKILL.md'), "---\nname: Bad_Name!\ndescription: x\n---\n")])
save('22-name-ne-folder.zip', [(zi('folder-a/SKILL.md'), "---\nname: other-name\ndescription: x\n---\n")])
laughs = "---\nname: laugh-a\ndescription: x\n" + "a0: &a0 [x,x,x,x,x,x,x,x,x]\n" + "".join("a%d: &a%d [*a%d,*a%d,*a%d,*a%d,*a%d,*a%d,*a%d,*a%d,*a%d]\n" % (i,i,i-1,i-1,i-1,i-1,i-1,i-1,i-1,i-1,i-1) for i in range(1,12)) + "---\n"
save('23-yaml-laughs.zip', [(zi('laugh-a/SKILL.md'), laughs)])
save('24-yaml-deepnest.zip', [(zi('deep-a/SKILL.md'), "---\nname: deep-a\ndescription: x\nk: " + "["*100000 + "]"*100000 + "\n---\n")])
save('25-yaml-tags.zip', [(zi('tag-a/SKILL.md'), "---\nname: tag-a\ndescription: !!python/object/apply:os.system ['touch /tmp/verify3-yaml-pwn']\n---\n")])
save('26-yaml-merge.zip', [(zi('merge-a/SKILL.md'), "---\nname: merge-a\ndescription: x\nbase: &b {k: v}\nother:\n  <<: *b\n---\n")])
save('27-nodesc.zip', [(zi('nod-a/SKILL.md'), "---\nname: nod-a\n---\n")])
save('28-exec-bit.zip', [ok('exec-a'), (zi('exec-a/scripts/run.sh', 0o100755), '#!/bin/sh\ntouch /tmp/verify3-script-pwn\n'), (zi('exec-a/tool.py', 0o100755), 'print(1)')])
# duplicate exact name (two central entries)
with zipfile.ZipFile(os.path.join(OUT, '29-dup-exact.zip'), 'w') as zf:
    zf.writestr(zi('dupx-a/SKILL.md'), GOOD % 'dupx-a')
    import warnings; warnings.simplefilter('ignore')
    zf.writestr(zi('dupx-a/f.txt'), 'one'); zf.writestr(zi('dupx-a/f.txt'), 'two')
print('wrote 29')
# bad local header vs central name
save('30-multiskill.zip', [ok('multi-a'), ok('multi-b')])
save('31-root-skill.zip', [(zi('SKILL.md'), GOOD % 'root-skill')])
save('32-dot-dir.zip', [ok('dot-a'), (zi('dot-a/./x.txt'), 'x')])
save('33-empty-component.zip', [ok('emp-a'), (zi('emp-a//x.txt'), 'x')])
save('34-skillmd-symlink.zip', [(zi('smd-a/SKILL.md', 0o120777), '/etc/passwd')])
save('35-device.zip', [ok('dev-a'), (zi('dev-a/null', 0o020666), '')])
save('36-nonutf8.zip', [ok('nu-a')])
# crc mismatch
b = bytearray(open(os.path.join(OUT, '00-good.zip'), 'rb').read())
idx = b.find(b'PK\x01\x02'); struct.pack_into('<I', b, idx+16, 0xdeadbeef); open(os.path.join(OUT, '37-badcrc.zip'), 'wb').write(b)
# declared size lies (small) but real data large: patch central+local usize to 5
bomb = io.BytesIO()
with zipfile.ZipFile(bomb, 'w') as zf:
    zf.writestr(zi('lie-a/SKILL.md'), GOOD % 'lie-a'); zf.writestr(zi('lie-a/z.bin'), b'\0'*(10*1024*1024))
bb = bytearray(bomb.getvalue());
cd = bb.find(b'PK\x01\x02', bb.find(b'z.bin')-80)
# find central entry for z.bin
pos = 0
while True:
    pos = bb.find(b'PK\x01\x02', pos)
    if pos < 0: break
    nl = struct.unpack_from('<H', bb, pos+28)[0]
    if bb[pos+46:pos+46+nl] == b'lie-a/z.bin': struct.pack_into('<I', bb, pos+24, 5); break
    pos += 4
open(os.path.join(OUT, '38-size-lie.zip'), 'wb').write(bb)
# prefix junk / polyglot: eocd inside comment
with zipfile.ZipFile(os.path.join(OUT, '39-comment-eocd.zip'), 'w') as zf:
    zf.writestr(zi('cm-a/SKILL.md'), GOOD % 'cm-a'); zf.comment = b'PK\x05\x06' + b'\0'*18
print('done')
