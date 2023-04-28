---This module contains injected profiling2 trackers for some popular (and problematic) addons, like
---Plater and WeakAuras2.
---
---If you're an addon author that wants to integrate Profiling2 into your addon, use
---`LibStub("Profiling2")` instead.

---@type ProfilingNs
local ns = select(2, ...)

local LibDeflate = LibStub("LibDeflate")

local function injectWA()
  if WeakAuras then
    ---@type function
    local origLoadFunction = WeakAuras.LoadFunction

    local trackers = {}

    function WeakAuras.LoadFunction(contents)
      local fn = origLoadFunction(contents)

      if fn == nil then
        return nil
      end

      local registrationComplete = false

      local triggerKey = LibDeflate:EncodeForPrint(LibDeflate:CompressDeflate(contents))

      local wrapped
      local outer = function(...)
        if not registrationComplete then
          -- this guards against repeat LoadFunction calls
          -- we also don't necessarily have aura_env.id yet when the LoadFunction call runs
          local env = getfenv(fn).aura_env
          local path = '@WeakAuras/Auras/' .. env.id .. '/' .. triggerKey .. ':CustomFn'

          if trackers[path] == nil then
            trackers[path] = ns.tracker.getScriptTracker()
          end

          local tracker = trackers[path]
          wrapped = ns.core.buildWrapper(tracker, fn)
          ns.core.registerExternalFunction(path, wrapped, tracker)
          registrationComplete = true
        end

        return wrapped(...)
      end

      return outer
    end
  end
end


if ns.isScriptProfilingEnabled() then
  local listener = CreateFrame('Frame', 'Profiling2Inject')
  listener:RegisterEvent("ADDON_LOADED")

  listener:SetScript("OnEvent", function(frame, eventName, addonName)
    if addonName == 'WeakAuras' then
      injectWA()
    end
  end)
end
