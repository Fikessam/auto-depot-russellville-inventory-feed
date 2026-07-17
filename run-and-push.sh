#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "/Users/sam/Scrappers/Auto Depot-R"
node scraper.js
if [ $? -eq 0 ]; then
  git add docs/feed-russellville.xml docs/inventory-russellville.json
  git commit -m "Automated feed update $(date '+%Y-%m-%d %H:%M')"
  git push
fi
