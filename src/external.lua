---This module contains code intended for use by external addon authors to get profiling data for
---their own code.

---@type ProfilingNs
local ns = select(2, ...)

---@class Profiling2
local externalNs = LibStub and LibStub:NewLibrary("Profiling2", 0) or {}

if type(ns) == 'table' then
  ns.external = externalNs
end

---comment
---@param key string
---@param fn function
---@return string
local function functionKey(key, fn)
  local addonName = ns.core.addonName(fn)
  return '@' .. addonName .. '/Functions:' .. key
end

---comment
---@param key string
---@param table table
---@return string
local function tableBaseKey(key, table)
  local addonName = ns.core.addonName(table)
  return '@' .. addonName .. '/Tables/' .. key
end

---Generate a tracked version of the function which records profiling data when called.
---Any calls to the original function WILL NOT be tracked.
---@param key string A unique name for the function being profiled.
---@param fn function
---@return function
function externalNs.trackedFunction(key, fn)
  local tracker = ns.tracker.getScriptTracker()
  local internalKey = functionKey(key, fn)
  local wrapped = ns.core.buildWrapper(tracker, fn)
  ns.core.registerExternalFunction(internalKey, wrapped, tracker)
  return wrapped
end

---Convenience function for tracking method(s) on a table. This replaces the method(s) on the table with
---tracked versions.
---
---Returns the modified table.
---@see Profiling2.trackedFunction 
---
---@param table table
---@param tableKey string
---@param methodNames table<string> 
---@return table
function externalNs.trackMethods(table, tableKey, methodNames)
  local baseKey = tableBaseKey(tableKey, table)
  for _, methodName in ipairs(methodNames) do
    table[methodName] = externalNs.trackedFunction(baseKey .. ':' .. methodName, table[methodName])
  end
  return table
end
