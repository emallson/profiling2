---This module contains code intended for use by external addon authors to get profiling data for
---their own code.

---@type ProfilingNs
local ns = select(2, ...)

---@class Profiling2
local externalNs = LibStub and LibStub("Profiling2", true) or {}

if type(ns) == 'table' then
  ns.external = externalNs
end

function externalNs.functionKey(key, fn)
  local addonName = ns.core.addonName(fn)
  return '@' .. addonName .. '/External/' .. key
end

---Generate a tracked version of the function which records profiling data when called.
---Any calls to the original function WILL NOT be tracked.
---@param key string
---@param fn function
---@return function
function externalNs.trackedFunction(key, fn)
  local tracker = ns.tracker.getScriptTracker()
  local internalKey = externalNs.functionKey(key, fn)
  local wrapped = ns.core.buildWrapper(tracker, fn)
  ns.core.registerExternalFunction(internalKey, wrapped, tracker)
  return wrapped
end

---Convenience function for tracking a method on a table. This replaces the method on the table with
---the tracked version.
---
---Returns the modified table.
---@see Profiling2.trackedFunction 
---
---@param table table
---@param key string
---@param methodName string
---@return table
function externalNs.trackMethod(table, key, methodName)
  table[methodName] = externalNs.trackedFunction(key, table[methodName])
  return table
end
