#!/bin/bash
set -u
cd /Volumes/wd2025/devel/aiworker/haos
DSH_HOME="$PWD/data/haos-home" dsh --profile haos --no-open --host 127.0.0.1 --port 30900 >/tmp/dsh-haos-inproc.log 2>&1 &
DSH_HOME="$PWD/data/instances/dsh-beta/dsh-home" dsh --profile haos --no-open --host 127.0.0.1 --port 30902 >/tmp/dsh-beta.log 2>&1 &
DSH_HOME="$PWD/data/instances/dsh-gamma/dsh-home" dsh --profile haos --no-open --host 127.0.0.1 --port 30903 >/tmp/dsh-gamma.log 2>&1 &
DSH_HOME="$PWD/data/existing-web" dsh --profile web --no-open --host 127.0.0.1 --port 30904 >/tmp/dsh-0005.log 2>&1 &
DSH_HOME="$PWD/data/existing-api" dsh --profile web --no-open --host 127.0.0.1 --port 30905 >/tmp/dsh-0008.log 2>&1 &
wait
