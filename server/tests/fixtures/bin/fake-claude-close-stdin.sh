#!/bin/sh

exec 0<&-
printf '%s\n' '{"type":"system","subtype":"init","session_id":"fake-closed-stdin","model":"fake","tools":[]}'
sleep 0.5
exit 1
