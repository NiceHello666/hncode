#!/usr/bin/env pwsh
#requires -version 5
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
& node "$here\hncode" @args
