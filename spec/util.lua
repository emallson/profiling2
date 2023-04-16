local assert = require('luassert')
local say = require('say')

say:set('assertion.leq', 'Expected %s <= %s')
say:set('assertion.lt', 'Expected %s < %s')
say:set('assertion.geq', 'Expected %s >= %s')
say:set('assertion.gt', 'Expected %s > %s')

assert:register("assertion", "leq", function(_, arguments) return arguments[1] <= arguments[2] end, 'assertion.leq', 'assertion.gt')
assert:register("assertion", "geq", function(_, arguments) return arguments[1] >= arguments[2] end, 'assertion.geq', 'assertion.lt')

local function pct_err(approx, exact)
  return math.abs(approx - exact) / exact
end

local function sample_stats(samples)
  local sample_mean = 0
  for _, sample in ipairs(samples) do
    sample_mean = sample_mean + sample
  end

  local n = #samples
  sample_mean = sample_mean / n

  local sample_m4 = 0
  local sample_m3 = 0
  local sample_m2 = 0
  for _, sample in ipairs(samples) do
    sample_m4 = sample_m4 + math.pow(sample - sample_mean, 4)
    sample_m3 = sample_m3 + math.pow(sample - sample_mean, 3)
    sample_m2 = sample_m2 + math.pow(sample - sample_mean, 2)
  end

  local sample_var = sample_m2 / (n - 1)
  local sample_skew = n * math.sqrt(n - 1) / (n - 2) * sample_m3 / math.pow(sample_m2, 1.5)
  local sample_kurt = (n - 1) / ((n - 2) * (n - 3)) * ((n + 1) * sample_m4 / math.pow(sample_m2, 2) - 3 * (n - 1))

  return sample_mean, sample_var, sample_skew, sample_kurt
end


return {
  pct_err = pct_err,
  sample_stats = sample_stats,
}
