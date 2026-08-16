#!/usr/bin/env python3
"""Hermes → DSH 技能扁平化同步脚本
遍历 ~/AppData/Local/hermes/skills/<category>/<name>/SKILL.md
→ 复制到 ~/.dsh/skills/<name>/（单层 bundle），保留 references/scripts/assets，
   templates/ → assets/
"""
import os, re, shutil, sys, yaml

HERMES_SKILLS = os.path.expanduser(r"C:\Users\ampct\AppData\Local\hermes\skills")
DSH_SKILLS = os.path.expanduser(r"C:\Users\ampct\.dsh\skills")
SKIP = {".archive"}  # 归档技能跳过

def is_kebab(s: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", s))

def main() -> None:
    os.makedirs(DSH_SKILLS, exist_ok=True)
    copied, skipped_fm, renamed = 0, [], 0
    problems = []
    names = {}

    for cat in sorted(os.listdir(HERMES_SKILLS)):
        catp = os.path.join(HERMES_SKILLS, cat)
        if not os.path.isdir(catp) or cat in SKIP:
            continue
        for skill in sorted(os.listdir(catp)):
            src = os.path.join(catp, skill, "SKILL.md")
            if not os.path.isfile(src):
                continue
            # 读 frontmatter 校验 name / description
            try:
                with open(src, encoding="utf-8") as f:
                    content = f.read()
                fm = content.split("---", 2)[1] if content.startswith("---") else ""
                meta = yaml.safe_load(fm) or {}
            except Exception as e:
                problems.append(f"{cat}/{skill}: frontmatter parse error: {e}")
                continue
            name = meta.get("name") or skill
            if not is_kebab(name):
                problems.append(f"{cat}/{skill}: name '{name}' 非 kebab-case")
                continue
            if not meta.get("description"):
                problems.append(f"{cat}/{skill}: 缺 description")
                continue
            if name in names:
                problems.append(f"{cat}/{skill}: name '{name}' 与 {names[name]} 冲突")
                continue
            names[name] = f"{cat}/{skill}"

            dst = os.path.join(DSH_SKILLS, name)
            os.makedirs(dst, exist_ok=True)
            # 主文件
            shutil.copy2(src, os.path.join(dst, "SKILL.md"))
            # bundle 子目录
            for sub in ("references", "scripts", "assets"):
                ssub = os.path.join(catp, skill, sub)
                if os.path.isdir(ssub):
                    shutil.copytree(ssub, os.path.join(dst, sub), dirs_exist_ok=True)
            # templates → assets
            tsub = os.path.join(catp, skill, "templates")
            if os.path.isdir(tsub):
                shutil.copytree(tsub, os.path.join(dst, "assets"), dirs_exist_ok=True)
                renamed += 1
            copied += 1

    print(f"copied: {copied}  templates→assets: {renamed}  skipped_fm: {len(skipped_fm)}")
    if problems:
        print("== PROBLEMS ==")
        for p in problems:
            print(" ", p)
    print("OK")

if __name__ == "__main__":
    main()
