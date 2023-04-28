---This module contains injected profiling2 trackers for some popular (and problematic) addons, like
---Plater and WeakAuras2.
---
---If you're an addon author that wants to integrate Profiling2 into your addon, use
---`LibStub("Profiling2")` instead.

---@type ProfilingNs
local ns = select(2, ...)

local listener = CreateFrame('Frame', 'Profiling2Inject')
local LibDeflate = LibStub("LibDeflate")

listener:RegisterEvent("ADDON_LOADED")

local function injectWA()
  if WeakAuras then
    ---@type function
    local origLoadFunction = WeakAuras.LoadFunction

    function WeakAuras.LoadFunction(contents)
      local fn = origLoadFunction(contents)

      if fn == nil then
        return nil
      end

      local tracker = ns.tracker.getScriptTracker()
      local registrationComplete = false

      local triggerKey = LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(contents))

      local wrapped = ns.core.buildWrapper(tracker, fn)
      local outer = function(...)
        if not registrationComplete then
          local env = getfenv(fn).aura_env
          local path = '@WeakAuras/Auras/' .. env.id .. '/' .. triggerKey .. ':CustomFn'
          ns.core.registerExternalFunction(path, wrapped, tracker)
          registrationComplete = true
        end

        return wrapped(...)
      end

      return outer
    end
  end
end

listener:SetScript("OnEvent", function(frame, eventName, addonName)
  if addonName == 'WeakAuras' then
    injectWA()
  end
end)

--#region WeakAuras2


--#endregion
