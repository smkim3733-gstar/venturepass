import sys,pathlib,openpyxl,collections,hashlib
sys.stdout.reconfigure(encoding='utf-8')
p=pathlib.Path('벤처기업명단(2026년8월).xlsx')
w=openpyxl.load_workbook(p,read_only=True,data_only=True)
raw=list(w.active.values); rows=[dict(zip(raw[0],r)) for r in raw[1:]]
x=[r for r in rows if r['벤처확인유형']=='혁신성장유형']; byid={r['연번']:r for r in rows}
lines=pathlib.Path('outputs/venture-202608/혁신성장유형_분석보고서.md').read_text(encoding='utf-8').splitlines()
errs=[]; checked=0
fmt=lambda s:f'{s[:4]}-{s[4:6]}-{s[6:]}'
for n,line in enumerate(lines,1):
    parts=[z.strip() for z in line.split('|')[1:-1]] if line.startswith('|') else []
    if len(parts)==7 and parts[0].isdigit():
        r=byid[int(parts[0])]
        expected=[str(r['연번']),r['업체명'],r['주소'],r['업종명(11차)'],r['주생산품'],r['신규/재확인'],fmt(r['벤처유효시작일'])+'~'+fmt(r['벤처유효종료일'])]
        if parts!=expected:errs.append((n,'예시 불일치',parts,expected))
        if r['벤처확인유형']!='혁신성장유형':errs.append((n,'예시 유형 불일치'))
        checked+=1
    if len(parts)==4 and parts[0].isdigit():
        c=sum(r['업종명(11차)']==parts[1] for r in x)
        if parts[2]!=f'{c:,}' or parts[3]!=f'{c/len(x)*100:.1f}%':errs.append((n,'세부업종 불일치',parts,c))
    if len(parts)==4 and parts[0] in set(r['업종분류(기보)'] for r in x) and not '%' in parts[2]:
        a=sum(r['업종분류(기보)']==parts[0] and r['신규/재확인']=='신규' for r in x)
        b=sum(r['업종분류(기보)']==parts[0] and r['신규/재확인']=='재확인' for r in x)
        exp=[parts[0],f'{a:,}',f'{b:,}',f'{b/(a+b)*100:.1f}%']
        if parts!=exp:errs.append((n,'신규 재확인 업종 교차표 불일치',parts,exp))
pair=collections.defaultdict(list)
for r in x:pair[(r['업체명'],r['주소'])].append(r)
dups=[v for v in pair.values() if len(v)>1]
print('MISMATCHES',errs)
print('EXAMPLES CHECKED',checked)
print('AUG2026',collections.Counter(r['신규/재확인'] for r in x if str(r['벤처유효시작일']).startswith('202608')))
print('MANUFACTURING GYEONGGI',sum(r['업종분류(기보)']=='제조업' and r['지역']=='경기' for r in x))
print('SOFTWARE SEOUL',sum(r['업종분류(기보)']=='정보처리S/W' and r['지역']=='서울' for r in x))
print('NAME ADDRESS DUPLICATES',[(v[0]['업체명'],v[0]['주소'],[{k:r[k] for k in ['연번','대표자명','주생산품']} for r in v]) for v in dups])
print('SHA256',hashlib.sha256(p.read_bytes()).hexdigest())
