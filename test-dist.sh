#!/usr/bin/env bash
mkdir -p '!Profiling2'
cp -r src '!Profiling2.toc' '!Profiling2/'
rsync -avzR libs/*/*.{toc,lua,xml} '!Profiling2/'
zip -r Profiling2.zip '!Profiling2'
