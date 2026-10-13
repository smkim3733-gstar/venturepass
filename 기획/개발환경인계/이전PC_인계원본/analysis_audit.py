import sys, json, collections, datetime, pathlib
import openpyxl
sys.stdout.reconfigure(encoding='utf-8')
source=pathlib.Path('벤처기업명단(2026년8월).xlsx')
w=openpyxl.load_workbook(source,read_only=True,data_only=True)
s=w.active
rows=list(s.values)
headers=rows[0]
records=[dict(zip(headers,r))|{'excel_row':i} for i,r in enumerate(rows[1:],2) if any(v is not None and v!='' for v in r)]
target=[r for r in records if r['벤처확인유형']=='혁신성장유형']
def distribution(rs,k):
    c=collections.Counter(r[k] for r in rs)
    return [{'value':v,'count':n,'pct':round(n/len(rs)*100,4)} for v,n in c.most_common()]
def audit(rs):
    missing={k:sum(r[k] is None or (isinstance(r[k],str) and not r[k].strip()) for r in rs) for k in headers}
    name_groups=collections.defaultdict(list)
    for r in rs:name_groups[r['업체명']].append(r)
    duplicated={k:v for k,v in name_groups.items() if len(v)>1}
    full=collections.Counter(tuple(r[k] for k in headers[1:]) for r in rs)
    parsed=[]; invalid=[]
    for r in rs:
        try:
            start=datetime.datetime.strptime(str(r['벤처유효시작일']),'%Y%m%d').date()
            end=datetime.datetime.strptime(str(r['벤처유효종료일']),'%Y%m%d').date()
            parsed.append((r,start,end))
        except Exception as e:invalid.append(r)
    snapshot=datetime.date(2026,8,31)
    return {
        'rows':len(rs),'missing':missing,
        'unique_names':len(name_groups),'duplicate_name_groups':len(duplicated),'duplicate_name_rows':sum(len(v) for v in duplicated.values()),'duplicate_name_excess':sum(len(v)-1 for v in duplicated.values()),
        'duplicate_full_excluding_serial_groups':sum(n>1 for n in full.values()),'duplicate_full_excluding_serial_excess':sum(n-1 for n in full.values() if n>1),
        'duplicate_name_examples':{k:[{c:r[c] for c in ['excel_row','연번','업체명','지역','주소','업종명(11차)','벤처유효시작일','벤처유효종료일']} for r in v] for k,v in list(duplicated.items())[:8]},
        'date_invalid_count':len(invalid),'date_start_range':[str(min(x[1] for x in parsed)),str(max(x[1] for x in parsed))],
        'date_end_range':[str(min(x[2] for x in parsed)),str(max(x[2] for x in parsed))],
        'date_end_before_start_count':sum(e<b for _,b,e in parsed),
        'valid_at_2026_08_31':sum(b<=snapshot<=e for _,b,e in parsed),
        'future_start_at_2026_08_31':sum(snapshot<b for _,b,e in parsed),
        'expired_at_2026_08_31':sum(e<snapshot for _,b,e in parsed),
        'duration_days':dict(collections.Counter((e-b).days for _,b,e in parsed).most_common()),
        'start_years':dict(collections.Counter(b.year for _,b,e in parsed).most_common()),
        'aug2026_start':sum(datetime.date(2026,8,1)<=b<=snapshot for _,b,e in parsed),
        'future_start_examples':[{c:r[c] for c in ['excel_row','연번','업체명','벤처확인유형','벤처유효시작일','벤처유효종료일']} for r,b,e in parsed if b>snapshot][:20],
    }
result={'sheet':s.title,'excel_dimension':s.calculate_dimension(),'headers':headers,'all':audit(records),'types':distribution(records,'벤처확인유형'),'innovation':audit(target)}
for key in ['업종분류(기보)','지역','신규/재확인','업종명(11차)']:
    result['innovation'][key]=distribution(target,key)
for key in ['업종분류(기보)','지역','신규/재확인']:
    result['all'][key]=distribution(records,key)
out=pathlib.Path('분석/data_audit.json');out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
display=json.loads(json.dumps(result))
display['innovation']['업종명(11차)']=display['innovation']['업종명(11차)'][:10]
print(json.dumps(display,ensure_ascii=False,indent=2))
