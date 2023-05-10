local newSketch = require('sketch')
local newHeap = require('heap')
local data = require('./spec/data')
local util = require('./spec/util')

describe('the distributional sketch system', function()
  -- note: the sketch stuff is specifically tuned for exponential data. true normal data will not be
  -- represented well because of left-truncation
  it('should generate a representative sample of exponentially distributed data ', function()
    local sketch = newSketch(newHeap)
    for _, value in ipairs(data.exponential) do
      sketch:push(value)
    end

    assert.are.equal(sketch:obs_count(), #data.exponential)
    local result = sketch:export()

    local exp_trivial = 0
    local max = 0
    for _, v in pairs(data.exponential) do
      if v <= sketch.T then
        exp_trivial = exp_trivial + 1
      end

      if v > max then
        max = v
      end
    end

    local bin_sum = 0
    for k, v in pairs(result.bins) do
      bin_sum = bin_sum + v
    end

    assert.are.equal(result.trivial_count, exp_trivial)
    assert.are.equal(bin_sum, #data.exponential - exp_trivial - #result.outliers)
    assert.are.equal(math.max(table.unpack(result.outliers)), max)
  end)

  it('should not generate bins if the sample is only trivial + a small amount of outliers', function()
    local sketch = newSketch(newHeap)
    for _ = 1, 1000 do
      sketch:push(0.1)
    end
    for _ = 1,5 do
      sketch:push(1000)
    end

    local result = sketch:export()

    assert.are.equal(result.trivial_count, 1000)
    assert.are.same(result.outliers, {1000, 1000, 1000, 1000, 1000})
    assert.is_nil(result.bins)
  end)

  it('should have acceptable performance', function()
    local RENDERS = 1000
    local HEAVY_FRAMES = 60
    local LIGHT_FRAMES = 540

    local heavy = {}
    local light = {}
    for _ = 1, HEAVY_FRAMES do
      table.insert(heavy, newSketch(newHeap))
    end

    for _ = 1, LIGHT_FRAMES do
      table.insert(light, newSketch(newHeap))
    end


    local starttime = os.clock()
    for _ = 1, RENDERS do
      local value = math.random() * 60
      for _, resv in ipairs(heavy) do
        resv:push(value)
      end

      value = math.random() * 0.6
      for _, resv in ipairs(light) do
        resv:push(value)
      end
    end
    local endtime = os.clock()

    local SIXTY_FPS = 1 / 60
    local TARGET = SIXTY_FPS / 100 * RENDERS
    local actual = endtime - starttime
    assert.are.geq(TARGET, actual)
  end)
end)
