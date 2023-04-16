local newEstimator = require('quantiles')
local data = require('./spec/data')


local sorted_data = {}
for _, value in ipairs(data.quantile_test) do
  table.insert(sorted_data, value)
end
table.sort(sorted_data)

local function sample_quantile(p)
  local index = p * (#sorted_data - 1) + 1
  local left, right = math.floor(index), math.ceil(index)

  if left == right then
    return sorted_data[left]
  else
    return (sorted_data[left] + sorted_data[right]) / 2
  end
end

local function pct_err(approx, exact)
  return math.abs(approx - exact) / exact
end

local TOLERANCE = 0.02

describe('the quantile estimator', function()
  it('should correctly estimate the quantiles of a stream of data', function()
    local est = newEstimator()
    for _, value in ipairs(data.quantile_test) do
      est:update(value)
    end
    assert.are.equal(#data.quantile_test, est:sample_count())

    local quantiles = est:quantiles()
    assert.is_not_nil(quantiles)
    for key, est_quant in pairs(quantiles or {}) do
      local p = tonumber(key)
      assert.are.geq(TOLERANCE, pct_err(est_quant, sample_quantile(p)))
    end
  end)

  it('should have acceptable performance', function()
    math.randomseed(os.time())

    local RENDERS = 1000
    local FRAMES = 300

    local ests = {}
    for _ = 1, FRAMES do
      table.insert(ests, newEstimator())
    end

    local starttime = os.clock()
    for _ = 1, RENDERS do
      local value = math.random()
      for i = 1, FRAMES do
        ests[i]:update(value)
      end
    end
    local endtime = os.clock()

    local SIXTY_FPS = 1 / 60
    local TARGET = SIXTY_FPS / 100 * RENDERS
    local actual = endtime - starttime
    assert.are.geq(TARGET, actual)
  end)
end)
